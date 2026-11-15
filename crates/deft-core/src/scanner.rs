// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    formats,
    model::{Book, BookFile, Folder, State},
};
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const SCAN_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub added: usize,
    pub missing: usize,
    pub scanned: usize,
    pub unchanged: usize,
    pub reattached: usize,
    pub errors: Vec<String>,
    pub skipped: bool,
}

pub struct Discovery {
    signature: String,
    files: Vec<(String, String, BookFile)>,
    metadata: HashMap<String, formats::Metadata>,
    live_roots: HashSet<String>,
    unreadable: Vec<PathBuf>,
    pub report: ScanReport,
    time: i64,
}

pub fn scan_signature(state: &State) -> String {
    serde_json::json!([
        state
            .folders
            .iter()
            .map(|folder| (&folder.id, &folder.path, &folder.exclusions))
            .collect::<Vec<_>>(),
        state.settings["formats"],
    ])
    .to_string()
}

pub fn canonical_directory(path: &Path) -> Result<String> {
    let path = dunce::canonicalize(path).context("Opening the folder")?;
    if !path.is_dir() {
        bail!("Select a folder.");
    }
    path.into_os_string()
        .into_string()
        .map_err(|_| anyhow!("This folder path cannot be represented in Deft."))
}

pub fn elapsed_scan(state: &State, time: i64) -> bool {
    state
        .last_scan
        .is_none_or(|last| time.saturating_sub(last) >= SCAN_INTERVAL_MS || time < last)
}

pub fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or("Untitled")
        .trim_end_matches(".fb2")
        .replace('_', " ")
        .trim()
        .to_owned()
}

fn fingerprint(path: &Path) -> Result<String> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut sha = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        sha.update(&buffer[..count]);
    }
    Ok(format!("{:x}", sha.finalize()))
}

fn stamp(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|time| time.as_nanos().try_into().ok())
        .unwrap_or_default()
}

impl Discovery {
    fn error(&mut self, path: &Path, error: impl std::fmt::Display) {
        if self.report.errors.len() < 250 {
            self.report
                .errors
                .push(format!("{}: {error}", path.display()));
        }
    }
}

pub fn discover(state: &State, time: i64) -> Discovery {
    let known = state
        .books
        .iter()
        .flat_map(|book| book.files.iter().map(move |file| (book, file)))
        .fold(HashMap::new(), |mut files, (book, file)| {
            let current: &mut (&Book, &BookFile) =
                files.entry(file.path.as_str()).or_insert((book, file));
            if current.1.missing && (!file.missing || current.1.last_seen_at < file.last_seen_at) {
                *current = (book, file);
            }
            files
        });
    let prior_ids: HashSet<&str> = state.books.iter().map(|book| book.id.as_str()).collect();
    let enabled: HashSet<&str> = state.settings["formats"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .collect();
    let mut result = Discovery {
        signature: scan_signature(state),
        files: vec![],
        metadata: HashMap::new(),
        live_roots: HashSet::new(),
        unreadable: vec![],
        report: ScanReport::default(),
        time,
    };
    let mut seen = HashSet::new();
    for folder in &state.folders {
        let root = Path::new(&folder.path);
        if fs::read_dir(root).is_err() {
            result.error(root, "folder unavailable");
            continue;
        }
        result.live_roots.insert(folder.id.clone());
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            if excluded(&directory, folder) {
                continue;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) => {
                    result.error(&directory, error);
                    result.unreadable.push(directory);
                    continue;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        result.error(&directory, error);
                        result.unreadable.push(directory.clone());
                        continue;
                    }
                };
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(kind) => kind,
                    Err(error) => {
                        result.error(&path, error);
                        result.unreadable.push(path);
                        continue;
                    }
                };
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    // Junctions and other reparse redirects must not escape the selected root.
                    if dunce::canonicalize(&path).is_ok_and(|resolved| resolved == path) {
                        directories.push(path);
                    }
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                let Some(kind) = formats::format(&path).filter(|kind| enabled.contains(kind))
                else {
                    continue;
                };
                let Some(path_string) = path.to_str().map(str::to_owned) else {
                    result.error(&path, "unsupported filename encoding");
                    continue;
                };
                if !seen.insert(path_string.clone()) {
                    continue;
                }
                result.report.scanned += 1;
                let info = match entry.metadata() {
                    Ok(info) => info,
                    Err(error) => {
                        result.error(&path, error);
                        result.unreadable.push(path.clone());
                        continue;
                    }
                };
                let size = info.len();
                let modified = stamp(&info);
                let file = BookFile {
                    path: path_string.clone(),
                    size,
                    modified,
                    last_seen_at: time,
                    missing: false,
                };
                if let Some((book, old)) = known.get(path_string.as_str()) {
                    if old.size == size && modified != 0 && old.modified == modified {
                        result.report.unchanged += 1;
                        result
                            .files
                            .push((book.id.clone(), book.format.clone(), file));
                        continue;
                    }
                }
                let hash = match fingerprint(&path) {
                    Ok(hash) => hash,
                    Err(error) => {
                        result.error(&path, error);
                        result.unreadable.push(path.clone());
                        continue;
                    }
                };
                if !prior_ids.contains(hash.as_str()) && !result.metadata.contains_key(&hash) {
                    let data = match formats::metadata(&path, kind) {
                        Ok(data) => data,
                        Err(error) => {
                            result.error(&path, error);
                            formats::filename_metadata(&path)
                        }
                    };
                    result.metadata.insert(hash.clone(), data);
                }
                if !fs::metadata(&path)
                    .is_ok_and(|latest| latest.len() == size && stamp(&latest) == modified)
                {
                    result.error(&path, "file changed during scan");
                    result.unreadable.push(path);
                    continue;
                }
                result.files.push((hash, kind.to_owned(), file));
            }
        }
    }
    result
}

fn excluded(path: &Path, folder: &Folder) -> bool {
    folder
        .exclusions
        .iter()
        .any(|excluded| path.starts_with(excluded))
}

pub fn apply(state: &mut State, mut result: Discovery) -> Result<ScanReport> {
    if result.signature != scan_signature(state) {
        bail!("Library folders changed during the scan. Run rescan again.");
    }
    let seen: HashMap<String, String> = result
        .files
        .iter()
        .map(|(hash, _, file)| (file.path.clone(), hash.clone()))
        .collect();
    let old_missing: HashMap<String, bool> = state
        .books
        .iter()
        .map(|book| (book.id.clone(), book.missing))
        .collect();
    for folder in &mut state.folders {
        folder.available = result.live_roots.contains(&folder.id);
    }
    for book in &mut state.books {
        for file in &mut book.files {
            if let Some(current) = seen.get(&file.path) {
                file.missing = current != &book.id;
                continue;
            }
            let path = Path::new(&file.path);
            let unavailable = state.folders.iter().any(|folder| {
                !folder.available && path.starts_with(&folder.path) && !excluded(path, folder)
            });
            if !unavailable
                && !result
                    .unreadable
                    .iter()
                    .any(|prefix| path.starts_with(prefix))
            {
                file.missing = true;
            }
        }
    }
    let mut existing: HashMap<String, usize> = state
        .books
        .iter()
        .enumerate()
        .map(|(i, book)| (book.id.clone(), i))
        .collect();
    for (hash, format, file) in result.files {
        let index = *existing.entry(hash.clone()).or_insert_with(|| {
            let mut metadata = result.metadata.remove(&hash).unwrap_or_default();
            if metadata.title.is_empty() {
                metadata.title = fallback_title(Path::new(&file.path));
            }
            state.books.push(Book {
                id: hash,
                format,
                metadata,
                added_at: result.time,
                ..Book::default()
            });
            result.report.added += 1;
            state.books.len() - 1
        });
        let book = &mut state.books[index];
        if let Some(previous) = book
            .files
            .iter_mut()
            .find(|previous| previous.path == file.path)
        {
            *previous = file;
        } else {
            book.files.push(file);
        }
    }
    state.last_scan = Some(result.time);
    state.rebuild_authors();
    crate::catalog::populate_series(state);
    for book in &state.books {
        match (old_missing.get(&book.id), book.missing) {
            (Some(false), true) => result.report.missing += 1,
            (Some(true), false) => result.report.reattached += 1,
            _ => {}
        }
    }
    Ok(result.report)
}

/// Imported files are reopened read-only and checked against the indexed revision.
/// This prevents accidentally reading changed content under an old Book ID.
pub fn source(book: &Book) -> Result<PathBuf> {
    for file in book.files.iter().filter(|file| !file.missing) {
        let path = PathBuf::from(&file.path);
        if let Ok(real) = dunce::canonicalize(&path) {
            if real != path {
                continue;
            }
            if let Ok(info) = fs::metadata(&path) {
                if !info.is_file() || info.len() != file.size {
                    continue;
                }
                if stamp(&info) == file.modified && file.modified != 0
                    || fingerprint(&path).is_ok_and(|hash| hash == book.id)
                {
                    return Ok(path);
                }
            }
        }
    }
    bail!("Deft cannot find this revision of the file. Rescan the library to find any changes.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deduplicates_moves_marks_revisions_missing_and_preserves_unavailable_roots() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let root = directory.path().join("books");
        fs::create_dir(&root)?;
        let old = root.join("a.txt");
        fs::write(&old, "One book")?;
        let mut state = State::default();
        state.folders.push(Folder {
            id: "root".into(),
            path: canonical_directory(&root)?,
            ..Folder::default()
        });
        let first = discover(&state, 1);
        assert_eq!(apply(&mut state, first)?.added, 1);
        state.books[0].favorite = true;
        fs::copy(&old, root.join("b.txt"))?;
        let second = discover(&state, 2);
        apply(&mut state, second)?;
        assert_eq!(state.books[0].files.len(), 2);
        fs::remove_file(&old)?;
        let third = discover(&state, 3);
        apply(&mut state, third)?;
        assert!(!state.books[0].missing);
        fs::rename(&root, directory.path().join("offline"))?;
        let fourth = discover(&state, 4);
        apply(&mut state, fourth)?;
        assert!(!state.books[0].missing);
        fs::rename(directory.path().join("offline"), &root)?;
        fs::write(root.join("b.txt"), "A revised book")?;
        let fifth = discover(&state, 5);
        apply(&mut state, fifth)?;
        assert!(state.books[0].missing && state.books[0].favorite);
        assert_eq!(state.books.len(), 2);
        Ok(())
    }
}
