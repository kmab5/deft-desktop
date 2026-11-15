// SPDX-License-Identifier: GPL-3.0-only
use anyhow::{anyhow, ensure, Result};
use deft_core::{
    cache::{self, PublicationCache},
    exchange,
    model::State,
    now, scanner,
    store::{public_snapshot, LibraryDelta, Store},
    tracking::Visit,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
};

pub struct Runtime {
    state: State,
    store: Store,
    visit: Option<Visit>,
    revision: u64,
    changes: VecDeque<(u64, LibraryDelta)>,
    change_bytes: usize,
}

impl Runtime {
    fn record(&mut self, delta: LibraryDelta) {
        if delta.is_empty() {
            return;
        }
        const HISTORY_BYTES: usize = 4 * 1024 * 1024;
        self.revision += 1;
        if delta.bytes > HISTORY_BYTES {
            self.changes.clear();
            self.change_bytes = 0;
            return;
        }
        self.change_bytes += delta.bytes;
        self.changes.push_back((self.revision, delta));
        while self.changes.len() > 64 || self.change_bytes > HISTORY_BYTES {
            if let Some((_, oldest)) = self.changes.pop_front() {
                self.change_bytes -= oldest.bytes;
            }
        }
    }
}

pub struct Desktop {
    runtime: Mutex<Runtime>,
    scanning: Mutex<()>,
    closing: AtomicBool,
    pub cache: PublicationCache,
    pub data: PathBuf,
}

impl Desktop {
    pub fn new(data: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data)?;
        let store = Store::open(&data.join("deft.sqlite3"))?;
        let state = store.load()?;
        let limit = cache::budget(state.settings["cacheLimitMb"].as_u64());
        let cache = PublicationCache::new(data.join("publications"), limit)?;
        Ok(Self {
            runtime: Mutex::new(Runtime {
                state,
                store,
                visit: None,
                revision: 0,
                changes: VecDeque::new(),
                change_bytes: 0,
            }),
            scanning: Mutex::new(()),
            closing: AtomicBool::new(false),
            cache,
            data,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Runtime>> {
        self.runtime
            .lock()
            .map_err(|_| anyhow!("Deft data is unavailable. Restart Deft."))
    }

    pub fn request_close_flush(&self) -> bool {
        if self.closing.load(Ordering::Acquire) {
            return false;
        }
        let reading = self.lock().is_ok_and(|runtime| runtime.visit.is_some());
        reading && !self.closing.swap(true, Ordering::AcqRel)
    }

    pub fn read<T>(&self, read: impl FnOnce(&State) -> Result<T>) -> Result<T> {
        read(&self.lock()?.state)
    }

    pub fn change<T>(&self, change: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        self.change_with_visit(|state, _| change(state))
    }

    pub fn change_with_visit<T>(
        &self,
        change: impl FnOnce(&mut State, &mut Option<Visit>) -> Result<T>,
    ) -> Result<T> {
        let mut runtime = self.lock()?;
        let Runtime {
            state,
            store,
            visit,
            ..
        } = &mut *runtime;
        let mut next = state.clone();
        let mut next_visit = visit.clone();
        let result = change(&mut next, &mut next_visit)?;
        let limit_changed = state.settings["cacheLimitMb"] != next.settings["cacheLimitMb"];
        let limit = cache::budget(next.settings["cacheLimitMb"].as_u64());
        let delta = store.save_updates(state, &next)?;
        *state = next;
        *visit = next_visit;
        runtime.record(delta);
        if limit_changed {
            let _ = self.cache.resize(limit);
        }
        Ok(result)
    }

    pub fn snapshot(&self, since: Option<u64>) -> Result<Value> {
        let runtime = self.lock()?;
        let earliest = runtime
            .changes
            .front()
            .map_or(runtime.revision, |(version, _)| version - 1);
        let cache_bytes = self.cache.size();
        if let Some(since) = since.filter(|since| (earliest..=runtime.revision).contains(since)) {
            let changes: Vec<_> = runtime
                .changes
                .iter()
                .filter_map(|(version, delta)| (*version > since).then_some(delta))
                .collect();
            return Ok(
                json!({"revision": runtime.revision, "changes": changes, "cacheBytes": cache_bytes}),
            );
        }
        let mut full = public_snapshot(&runtime.state)?;
        full["cacheBytes"] = cache_bytes.into();
        Ok(json!({"revision": runtime.revision, "full": full}))
    }

    pub fn scan(&self, force: bool) -> Result<scanner::ScanReport> {
        let _scan = self
            .scanning
            .lock()
            .map_err(|_| anyhow!("Scanner unavailable."))?;
        let state = self.read(|state| Ok(state.clone()))?;
        let time = now();
        if !force && !scanner::elapsed_scan(&state, time) {
            return Ok(scanner::ScanReport {
                skipped: true,
                ..Default::default()
            });
        }
        let discovery = scanner::discover(&state, time);
        self.change(|state| scanner::apply(state, discovery))
    }

    pub fn archive(&self) -> Result<Vec<u8>> {
        let (database, manifest) = {
            let runtime = self.lock()?;
            (
                runtime.store.backup(&self.data)?,
                json!({"folders": runtime.state.folders}),
            )
        };
        exchange::backup(&manifest, &database)
    }

    pub fn restore(&self, bytes: &[u8]) -> Result<Vec<String>> {
        let payload = exchange::restore(bytes)?;
        let mut replacement = Store::decode_backup(&self.data, &payload)?;
        replacement.last_scan = None;
        replacement.settings["backupEnabled"] = Value::Bool(false);
        replacement.settings["dictionaryPath"] = Value::Null;
        let mut folders = vec![];
        for folder in &mut replacement.folders {
            folders.push(folder.path.clone());
            folder.available = Path::new(&folder.path).is_dir();
        }
        replacement.rebuild_authors();
        let limit = cache::budget(replacement.settings["cacheLimitMb"].as_u64());
        let mut runtime = self.lock()?;
        let Runtime {
            state,
            store,
            visit,
            ..
        } = &mut *runtime;
        let delta = store.save_updates(state, &replacement)?;
        *state = replacement;
        *visit = None;
        runtime.record(delta);
        let _ = self.cache.resize(limit);
        Ok(folders)
    }

    pub fn weekly_backup(&self) -> Result<()> {
        let settings = self.read(|state| Ok(state.settings.clone()))?;
        if settings["backupEnabled"].as_bool() != Some(true) {
            return Ok(());
        }
        let folder = settings["backupFolder"]
            .as_str()
            .ok_or_else(|| anyhow!("Select a backup folder."))?;
        let time = settings["lastWeeklyBackupAt"].as_i64().unwrap_or(0);
        if now().saturating_sub(time) < 7 * 86_400_000 {
            return Ok(());
        }
        let keep = settings["backupKeep"].as_u64().unwrap_or(4).clamp(1, 52);
        let archive = self.archive()?;
        exchange::rotate_weekly(Path::new(folder), keep as usize, &archive)?;
        self.change(|state| {
            state.settings["lastWeeklyBackupAt"] = now().into();
            Ok(())
        })
    }

    pub fn source(&self, book_id: &str) -> Result<deft_core::model::Book> {
        self.read(|state| {
            let mut book = deft_core::catalog::book(state, book_id)?.clone();
            ensure!(!book.ignored, "Restore this book from ignored books first.");
            book.files.retain(|file| {
                let path = Path::new(&file.path);
                state.folders.iter().any(|folder| {
                    path.starts_with(&folder.path)
                        && !folder
                            .exclusions
                            .iter()
                            .any(|excluded| path.starts_with(excluded))
                })
            });
            Ok(book)
        })
    }
}

// SetThreadExecutionState is thread-local. The application schedules both calls on
// the window thread, including the focus-loss fallback.
#[cfg(windows)]
pub fn keep_awake(on: bool) {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(state: u32) -> u32;
    }
    // SAFETY: These are documented execution-state flags and take no pointers.
    unsafe {
        SetThreadExecutionState(if on { 0x8000_0002 } else { 0x8000_0000 });
    }
}
#[cfg(not(windows))]
pub fn keep_awake(_: bool) {}
