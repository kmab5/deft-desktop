// SPDX-License-Identifier: GPL-3.0-only
use anyhow::{anyhow, ensure, Result};
use deft_core::{exchange, model::State, now, scanner, store::Store, tracking::Visit};
use serde_json::Value;
use std::{
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
}

pub struct Desktop {
    runtime: Mutex<Runtime>,
    scanning: Mutex<()>,
    closing: AtomicBool,
    pub cache_lock: Mutex<()>,
    pub data: PathBuf,
}

impl Desktop {
    pub fn new(data: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data)?;
        let mut store = Store::open(&data.join("deft.sqlite3"))?;
        let state = store.load()?;
        store.save(&state)?;
        Ok(Self {
            runtime: Mutex::new(Runtime {
                state,
                store,
                visit: None,
            }),
            scanning: Mutex::new(()),
            closing: AtomicBool::new(false),
            cache_lock: Mutex::new(()),
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
        let mut next = runtime.state.clone();
        let mut visit = runtime.visit.clone();
        let result = change(&mut next, &mut visit)?;
        runtime.store.save(&next)?;
        runtime.state = next;
        runtime.visit = visit;
        Ok(result)
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
        let runtime = self.lock()?;
        let database = runtime.store.backup(&self.data)?;
        exchange::backup(&serde_json::to_value(&runtime.state)?, &database)
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
        let mut runtime = self.lock()?;
        runtime.store.save(&replacement)?;
        runtime.state = replacement;
        runtime.visit = None;
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

pub fn cache_bytes(path: &Path) -> u64 {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.metadata().ok().filter(fs::Metadata::is_file))
        .map(|metadata| metadata.len())
        .sum()
}
