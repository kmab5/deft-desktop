// SPDX-License-Identifier: GPL-3.0-only
use crate::desktop::Desktop;
use anyhow::{ensure, Result};
use deft_core::{
    formats::{self, Publication},
    model::Book,
    scanner,
};
use serde_json::Value;
use std::fs;

const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CONVERSION_BYTES: usize = 384 * 1024 * 1024;
const MAX_CONVERSION_CHAPTERS: usize = 12_000;

pub fn open(desktop: &Desktop, book: &Book) -> Result<Value> {
    ensure!(
        !book.protected,
        "This file is DRM-protected. Deft cannot open it."
    );
    let path = scanner::source(book)?;
    let cacheable = matches!(book.format.as_str(), "epub" | "txt" | "fb2");
    if cacheable || kindle(book) {
        if let Some(value) = desktop.cache.get(&book.id) {
            return Ok(value);
        }
    }
    let publication = serde_json::to_value(formats::open(&path, &book.format)?)?;
    if cacheable {
        let _ = desktop.cache.put(&book.id, &publication);
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
    desktop
        .cache
        .put(&book.id, &serde_json::to_value(publication)?)
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

pub fn prewarm(desktop: &Desktop) {
    let Ok(books) = desktop.read(|state| {
        if state.settings["prepareInBackground"].as_bool() != Some(true) {
            return Ok(Vec::new());
        }
        let mut recent: Vec<_> = state
            .books
            .iter()
            .filter_map(|book| {
                let time = book.last_opened_at?;
                (!book.missing
                    && !book.ignored
                    && !book.protected
                    && matches!(book.format.as_str(), "txt" | "fb2" | "epub"))
                .then_some((time, book.id.as_str()))
            })
            .collect();
        recent.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
        Ok(recent
            .into_iter()
            .take(8)
            .map(|(_, id)| id.to_owned())
            .collect::<Vec<_>>())
    }) else {
        return;
    };
    for id in books {
        if let Ok(book) = desktop.source(&id) {
            let _ = open(desktop, &book);
        }
    }
}
