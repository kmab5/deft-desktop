// SPDX-License-Identifier: GPL-3.0-only
use anyhow::{anyhow, Result};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Mutex, MutexGuard},
    time::SystemTime,
};

pub const DEFAULT_BUDGET_MB: u64 = 128;
const MAX_ENTRIES: usize = 64;
const MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES: usize = 48 * 1024 * 1024;
const SUFFIX: &str = "-v2.json.gz";
const OLD_SUFFIX: &str = "-v1.json";

pub fn budget(megabytes: Option<u64>) -> u64 {
    megabytes.unwrap_or(DEFAULT_BUDGET_MB).min(16_384) * 1024 * 1024
}

fn valid_key(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

struct Entry {
    size: u64,
    touched: SystemTime,
}

#[derive(Default)]
struct Index {
    entries: HashMap<String, Entry>,
    bytes: u64,
    generation: u64,
    limit: u64,
}

pub struct PublicationCache {
    directory: PathBuf,
    index: Mutex<Index>,
}

impl PublicationCache {
    pub fn new(directory: PathBuf, limit: u64) -> Result<Self> {
        let mut index = Index {
            limit,
            ..Index::default()
        };
        if directory.is_dir() {
            for entry in fs::read_dir(&directory)?.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if !kind.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if name.strip_suffix(OLD_SUFFIX).is_some_and(valid_key) {
                    // These are derived files from the old uncompressed cache.
                    let _ = fs::remove_file(entry.path());
                    continue;
                }
                let Some(id) = name.strip_suffix(SUFFIX).filter(|id| valid_key(id)) else {
                    continue;
                };
                let info = entry.metadata()?;
                let size = info.len();
                let touched = info.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                index.bytes += size;
                index.entries.insert(id.into(), Entry { size, touched });
            }
        }
        let cache = Self {
            directory,
            index: Mutex::new(index),
        };
        cache.resize(limit)?;
        Ok(cache)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Index>> {
        self.index.lock().map_err(|_| anyhow!("Cache unavailable."))
    }

    fn path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}{SUFFIX}"))
    }

    pub fn size(&self) -> u64 {
        self.lock().map(|index| index.bytes).unwrap_or_default()
    }

    fn remove(&self, index: &mut Index, id: &str) -> Result<()> {
        match fs::remove_file(self.path(id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if let Some(entry) = index.entries.remove(id) {
            index.bytes = index.bytes.saturating_sub(entry.size);
        }
        Ok(())
    }

    fn trim(&self, index: &mut Index, incoming_size: u64, incoming_count: usize) -> Result<()> {
        let mut sorted: Vec<_> = index
            .entries
            .iter()
            .map(|(id, entry)| (entry.touched, id.clone()))
            .collect();
        sorted.sort_unstable();
        for (_, id) in sorted {
            if index.bytes.saturating_add(incoming_size) <= index.limit
                && index.entries.len() + incoming_count <= MAX_ENTRIES
            {
                break;
            }
            self.remove(index, &id)?;
        }
        Ok(())
    }

    pub fn resize(&self, limit: u64) -> Result<()> {
        let mut index = self.lock()?;
        index.limit = limit;
        self.trim(&mut index, 0, 0)
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        let file = {
            let mut index = self.lock().ok()?;
            let entry = index.entries.get_mut(id)?;
            let path = self.path(id);
            let file = fs::File::open(&path).ok()?;
            entry.touched = SystemTime::now();
            let _ = fs::OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|handle| handle.set_modified(entry.touched));
            file
        };
        let mut data = Vec::new();
        GzDecoder::new(file)
            .take(MAX_EXPANDED_BYTES as u64 + 1)
            .read_to_end(&mut data)
            .ok()?;
        (data.len() <= MAX_EXPANDED_BYTES)
            .then(|| serde_json::from_slice(&data).ok())
            .flatten()
    }

    pub fn put(&self, id: &str, publication: &Value) -> Result<()> {
        if !valid_key(id) {
            return Ok(());
        }
        let generation = {
            let index = self.lock()?;
            if index.limit == 0 {
                return Ok(());
            }
            index.generation
        };
        let plain = serde_json::to_vec(publication)?;
        if plain.len() > MAX_EXPANDED_BYTES {
            return Ok(());
        }
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(&plain)?;
        let compressed = gzip.finish()?;
        let size = compressed.len() as u64;
        let mut index = self.lock()?;
        if index.generation != generation
            || size > index.limit
            || compressed.len() > MAX_ENTRY_BYTES
        {
            return Ok(());
        }
        if index.entries.contains_key(id) {
            self.remove(&mut index, id)?;
        }
        self.trim(&mut index, size, 1)?;
        fs::create_dir_all(&self.directory)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        temporary.write_all(&compressed)?;
        temporary.persist(self.path(id))?;
        index.bytes += size;
        index.entries.insert(
            id.into(),
            Entry {
                size,
                touched: SystemTime::now(),
            },
        );
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        let mut index = self.lock()?;
        index.generation = index.generation.wrapping_add(1);
        let ids: Vec<_> = index.entries.keys().cloned().collect();
        for id in ids {
            self.remove(&mut index, &id)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uses_a_bounded_compressed_working_set_and_removes_legacy_entries() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let legacy = directory.path().join(format!("{:064x}{OLD_SUFFIX}", 1000));
        let unrelated = directory.path().join("keep-me.txt");
        fs::write(&legacy, "old cache")?;
        fs::write(&unrelated, "unrelated file")?;
        let cache = PublicationCache::new(directory.path().into(), budget(None))?;
        assert!(!legacy.exists());
        assert!(unrelated.exists());
        let publication = json!({"kind": "text", "body": "chapter text".repeat(30_000)});
        for id in 0..70 {
            cache.put(&format!("{id:064x}"), &publication)?;
        }
        assert_eq!(cache.lock()?.entries.len(), MAX_ENTRIES);
        assert!(cache.size() < 1024 * 1024);
        assert_eq!(cache.get(&format!("{:064x}", 69)), Some(publication));
        cache.resize(1)?;
        assert_eq!(cache.size(), 0);
        Ok(())
    }
}
