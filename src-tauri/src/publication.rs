// SPDX-License-Identifier: GPL-3.0-only
use crate::desktop::{cache_bytes, Desktop};
use anyhow::{anyhow, ensure, Result};
use deft_core::{
    formats::{self, Publication},
    model::Book,
    scanner,
};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::SystemTime,
};

const CACHE_VERSION: u32 = 1;
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CONVERSION_BYTES: usize = 384 * 1024 * 1024;
const MAX_CONVERSION_CHAPTERS: usize = 12_000;

fn cache_file(directory: &Path, book: &Book) -> Result<PathBuf> {
    ensure!(
        book.id.len() == 64 && book.id.bytes().all(|c| c.is_ascii_hexdigit()),
        "Invalid book identifier."
    );
    Ok(directory.join(format!("{}-v{CACHE_VERSION}.json", book.id)))
}

pub fn open(desktop: &Desktop, book: &Book) -> Result<Value> {
    ensure!(
        !book.protected,
        "This file is DRM-protected. Deft cannot open it."
    );
    let path = scanner::source(book)?;
    let cacheable = matches!(book.format.as_str(), "epub" | "txt" | "fb2");
    let directory = desktop.data.join("publications");
    let target = cache_file(&directory, book)?;
    if cacheable || kindle(book) {
        if let Ok(bytes) = fs::read(&target) {
            if let Ok(value) = serde_json::from_slice(&bytes) {
                let _ = fs::OpenOptions::new()
                    .write(true)
                    .open(&target)
                    .and_then(|file| file.set_modified(SystemTime::now()));
                return Ok(value);
            }
        }
    }
    let publication = serde_json::to_value(formats::open(&path, &book.format)?)?;
    if cacheable {
        let limit =
            desktop.read(|state| Ok(state.settings["cacheLimitMb"].as_u64().unwrap_or(1024)))?;
        let _ = save_cache(
            desktop,
            &directory,
            &target,
            &publication,
            limit.min(16_384) * 1024 * 1024,
        );
    }
    Ok(publication)
}

fn kindle(book: &Book) -> bool {
    matches!(book.format.as_str(), "mobi" | "azw" | "azw3")
}

pub fn cache_kindle(desktop: &Desktop, book: &Book, publication: Publication) -> Result<()> {
    ensure!(
        kindle(book) && !book.protected,
        "This book has no cacheable Kindle conversion."
    );
    ensure!(
        publication.kind == "text"
            && !publication.chapters.is_empty()
            && publication.chapters.len() <= MAX_CONVERSION_CHAPTERS
            && publication.toc.len() <= MAX_CONVERSION_CHAPTERS
            && publication
                .toc
                .iter()
                .all(|entry| entry.chapter < publication.chapters.len()),
        "Invalid converted Kindle publication."
    );
    let length = publication
        .chapters
        .iter()
        .fold(0_usize, |length, chapter| {
            length
                .saturating_add(chapter.html.len())
                .saturating_add(chapter.title.len())
        });
    ensure!(
        length <= MAX_CONVERSION_BYTES,
        "This Kindle conversion is too large."
    );
    let path = scanner::source(book)?;
    formats::open(&path, &book.format)?;
    let limit =
        desktop.read(|state| Ok(state.settings["cacheLimitMb"].as_u64().unwrap_or(1024)))?;
    let directory = desktop.data.join("publications");
    let target = cache_file(&directory, book)?;
    let publication = serde_json::to_value(publication)?;
    save_cache(
        desktop,
        &directory,
        &target,
        &publication,
        limit.min(16_384) * 1024 * 1024,
    )
}

pub fn asset(book: &Book, index: Option<usize>) -> Result<Vec<u8>> {
    ensure!(
        !book.protected,
        "This file is DRM-protected. Deft cannot open it."
    );
    let path = scanner::source(book)?;
    ensure!(formats::format(&path).is_some(), "Unsupported book file.");
    if matches!(
        book.format.as_str(),
        "pdf" | "djvu" | "mobi" | "azw" | "azw3"
    ) {
        ensure!(
            fs::metadata(&path)?.len() <= MAX_ASSET_BYTES,
            "This file exceeds the 512 MB reader limit."
        );
    }
    formats::asset(&path, &book.format, index)
}

fn save_cache(
    desktop: &Desktop,
    directory: &Path,
    target: &Path,
    publication: &Value,
    limit: u64,
) -> Result<()> {
    if limit == 0 {
        return Ok(());
    }
    let data = serde_json::to_vec(publication)?;
    if data.len() as u64 > limit {
        return Ok(());
    }
    let _guard = desktop
        .cache_lock
        .lock()
        .map_err(|_| anyhow!("Cache unavailable."))?;
    fs::create_dir_all(directory)?;
    let mut entries = fs::read_dir(directory)?
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            (metadata.is_file() && entry.path() != target).then(|| {
                (
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    metadata.len(),
                    entry.path(),
                )
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.0);
    let mut total = data.len() as u64 + entries.iter().map(|entry| entry.1).sum::<u64>();
    for (_, size, path) in entries {
        if total <= limit {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
    if total > limit {
        return Ok(());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(&data)?;
    temporary.persist(target)?;
    Ok(())
}

pub fn clear(desktop: &Desktop) -> Result<()> {
    let _guard = desktop
        .cache_lock
        .lock()
        .map_err(|_| anyhow!("Cache unavailable."))?;
    let directory = desktop.data.join("publications");
    if directory.exists() {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

pub fn prewarm(desktop: &Desktop) {
    let Ok((books, limit)) = desktop.read(|state| {
        let books = if state.settings["prepareInBackground"].as_bool() == Some(true) {
            state
                .books
                .iter()
                .filter(|book| {
                    !book.missing
                        && !book.ignored
                        && !book.protected
                        && matches!(book.format.as_str(), "txt" | "fb2" | "epub")
                })
                .map(|book| book.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        Ok((
            books,
            state.settings["cacheLimitMb"]
                .as_u64()
                .unwrap_or(1024)
                .min(16_384),
        ))
    }) else {
        return;
    };
    let directory = desktop.data.join("publications");
    for id in books {
        if cache_bytes(&directory) >= limit * 1024 * 1024 {
            break;
        }
        if let Ok(book) = desktop.source(&id) {
            if cache_file(&directory, &book).is_ok_and(|path| !path.exists()) {
                let _ = open(desktop, &book);
            }
        }
    }
}
