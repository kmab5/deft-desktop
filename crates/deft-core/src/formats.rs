//! Read-only publication inspection and a common reader payload for local books.

mod djvu;
mod epub;
mod fixed;
mod kindle;
mod text;

use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use image::{codecs::jpeg::JpegEncoder, ImageFormat, ImageReader, Limits};
use kuchiki::{traits::TendrilSink, NodeRef};
use roxmltree::{Document, Node, ParsingOptions};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};
use zip::{result::ZipError, ZipArchive};

// These limits apply to decoded entries and uploads to the local WebView, not scanning or hashing.
const TEXT_LIMIT: u64 = 48 * 1024 * 1024;
const ARCHIVE_IMAGE_LIMIT: u64 = 24 * 1024 * 1024;
const ASSET_LIMIT: u64 = 384 * 1024 * 1024;
const BINARY_LIMIT: u64 = 512 * 1024 * 1024;
const XML_LIMIT: u64 = 4 * 1024 * 1024;
const PROTECTED: &str = "This file is DRM-protected. Deft can't open it.";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Metadata {
    pub title: String,
    pub authors: Vec<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub description: Option<String>,
    pub isbn10: Option<String>,
    pub isbn13: Option<String>,
    pub page_count: Option<usize>,
    pub cover: Option<String>,
    pub protected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub title: String,
    pub html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    pub title: String,
    pub chapter: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chapters: Vec<Chapter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub toc: Vec<TocEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<usize>,
}

impl Publication {
    fn text(
        chapters: Vec<Chapter>,
        mut toc: Vec<TocEntry>,
        language: Option<String>,
    ) -> Result<Self> {
        ensure!(!chapters.is_empty(), "No readable chapters were found.");
        ensure!(
            chapters
                .iter()
                .map(|chapter| chapter.html.len() as u64)
                .sum::<u64>()
                <= ASSET_LIMIT,
            "This book expands beyond the desktop reader's size limit."
        );
        if toc.is_empty() {
            toc = chapters
                .iter()
                .enumerate()
                .map(|(chapter, item)| TocEntry {
                    title: item.title.clone(),
                    chapter,
                    href: None,
                })
                .collect();
        }
        Ok(Self {
            kind: "text".to_owned(),
            language,
            chapters,
            toc,
            page_count: None,
        })
    }

    fn fixed(kind: &'static str, page_count: Option<usize>) -> Self {
        Self {
            kind: kind.to_owned(),
            language: None,
            chapters: Vec::new(),
            toc: Vec::new(),
            page_count,
        }
    }
}

/// Return one of the nine canonical formats, independent of extension casing.
pub fn format(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if name.ends_with(".fb2.zip") {
        return Some("fb2");
    }
    match name.rsplit_once('.')?.1 {
        "epub" => Some("epub"),
        "mobi" | "prc" => Some("mobi"),
        "azw" => Some("azw"),
        "azw3" | "kf8" => Some("azw3"),
        "fb2" => Some("fb2"),
        "txt" => Some("txt"),
        "pdf" => Some("pdf"),
        "djvu" | "djv" => Some("djvu"),
        "cbz" => Some("cbz"),
        _ => None,
    }
}

/// Used by the scanner if extraction fails or the file omits metadata.
pub fn filename_metadata(path: &Path) -> Metadata {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let name = if name.to_ascii_lowercase().ends_with(".fb2.zip") {
        &name[..name.len() - ".fb2.zip".len()]
    } else {
        name.rsplit_once('.')
            .map_or(name.as_ref(), |(stem, _)| stem)
    };
    let name = clean_filename(&name.replace('_', " "));
    let mut metadata = Metadata {
        title: name.clone(),
        ..Metadata::default()
    };
    let parts: Vec<_> = name.split(" - ").map(str::trim).collect();
    if let [series, position, title] = parts.as_slice() {
        if let Some(index) = parse_position(position) {
            if !series.is_empty() && !title.is_empty() {
                metadata.series = Some((*series).to_owned());
                metadata.series_index = Some(index);
                metadata.title = (*title).to_owned();
                return metadata;
            }
        }
    }
    if let Some((title, suffix)) = name.strip_suffix(')').and_then(|s| s.rsplit_once(" (")) {
        if let Some((series, position)) = suffix.rsplit_once('#') {
            if let Some(index) = parse_position(position) {
                if !series.trim().is_empty() && !title.trim().is_empty() {
                    metadata.series = Some(series.trim().to_owned());
                    metadata.series_index = Some(index);
                    metadata.title = title.trim().to_owned();
                    return metadata;
                }
            }
        }
    }
    if let [author, title] = parts.as_slice() {
        if !author.is_empty() && !title.is_empty() {
            metadata.authors = vec![(*author).to_owned()];
            metadata.title = (*title).to_owned();
        }
    }
    metadata
}

fn clean_filename(stem: &str) -> String {
    let mut result = String::with_capacity(stem.len());
    let mut remaining = stem;
    while let Some((before, after)) = remaining.split_once('[') {
        result.push_str(before);
        let Some((tag, rest)) = after.split_once(']') else {
            result.push('[');
            remaining = after;
            break;
        };
        let lower = tag.trim().to_ascii_lowercase();
        let version = lower.strip_prefix('v').is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|value| value.is_ascii_digit())
        });
        let year = lower.len() == 4 && lower.bytes().all(|value| value.is_ascii_digit());
        if !(matches!(lower.as_str(), "retail" | "epub" | "pdf" | "scan" | "ocr")
            || version
            || year)
        {
            result.push('[');
            result.push_str(tag);
            result.push(']');
        }
        remaining = rest;
    }
    result.push_str(remaining);
    let result = collapse(&result);
    if result.is_empty() {
        "Untitled".to_owned()
    } else {
        result
    }
}

pub fn metadata(path: &Path, kind: &str) -> Result<Metadata> {
    let fallback = filename_metadata(path);
    let mut metadata = match kind {
        "epub" => epub::metadata(path),
        "fb2" => text::fb2_metadata(path),
        "txt" => {
            ensure!(path.metadata()?.len() > 0, "The text file is empty.");
            Ok(Metadata::default())
        }
        "mobi" | "azw" | "azw3" => kindle::metadata(path),
        "cbz" => fixed::cbz_metadata(path),
        "pdf" => fixed::pdf_metadata(path),
        "djvu" => djvu::metadata(path),
        _ => bail!("Unsupported book format."),
    }?;
    if metadata.title.is_empty() {
        metadata.title = fallback.title;
    }
    if metadata.authors.is_empty() {
        metadata.authors = fallback.authors;
    }
    if metadata.series.is_none() {
        metadata.series = fallback.series;
        metadata.series_index = fallback.series_index;
    }
    Ok(metadata)
}

pub fn open(path: &Path, kind: &str) -> Result<Publication> {
    match kind {
        "epub" => epub::open(path),
        "fb2" => text::open_fb2(path),
        "txt" => text::open_txt(path),
        "cbz" => fixed::open_cbz(path),
        "pdf" => fixed::open_pdf(path),
        "djvu" => djvu::open(path),
        "mobi" | "azw" | "azw3" => kindle::open(path),
        _ => bail!("Unsupported book format."),
    }
}

/// Only fixed-layout page images and local viewer documents have binary assets.
pub fn asset(path: &Path, kind: &str, index: Option<usize>) -> Result<Vec<u8>> {
    match (kind, index) {
        ("cbz", Some(index)) => fixed::cbz_asset(path, index),
        ("pdf", None) => {
            fixed::check_pdf_header(path)?;
            read_file(path, BINARY_LIMIT)
        }
        ("djvu", None) => {
            djvu::open(path)?;
            read_file(path, BINARY_LIMIT)
        }
        ("mobi" | "azw" | "azw3", None) => kindle::asset(path),
        _ => bail!("No such reader asset."),
    }
}

fn parse_position(position: &str) -> Option<f64> {
    position
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn read_file(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    ensure!(
        file.metadata()?.len() <= limit,
        "This file is too large to open."
    );
    read_limited(file, limit)
}

fn read_limited(reader: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    reader.take(limit + 1).read_to_end(&mut data)?;
    ensure!(
        data.len() as u64 <= limit,
        "This resource is too large to open."
    );
    Ok(data)
}

fn open_zip(path: &Path) -> Result<ZipArchive<File>> {
    ZipArchive::new(File::open(path)?).context("Invalid ZIP book container.")
}

fn zip_entry(archive: &mut ZipArchive<File>, name: &str, limit: u64) -> Result<Vec<u8>> {
    let item = archive
        .by_name(name)
        .with_context(|| format!("Missing or unreadable archive resource: {name}"))?;
    ensure!(
        item.size() <= limit,
        "Archive resource is too large: {name}"
    );
    read_limited(item, limit)
}

fn zip_optional(archive: &mut ZipArchive<File>, name: &str, limit: u64) -> Result<Option<Vec<u8>>> {
    match archive.by_name(name) {
        Ok(item) => {
            ensure!(
                item.size() <= limit,
                "Archive resource is too large: {name}"
            );
            read_limited(item, limit).map(Some)
        }
        Err(ZipError::FileNotFound) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn decode(data: &[u8], charset: Option<&str>) -> String {
    if let Some((encoding, length)) = Encoding::for_bom(data) {
        return encoding
            .decode_without_bom_handling(&data[length..])
            .0
            .into_owned();
    }
    let encoding = charset
        .and_then(|label| Encoding::for_label(label.as_bytes()))
        .unwrap_or_else(|| {
            let pairs = data.chunks_exact(2).take(1024);
            let count = pairs.len();
            if count >= 4 {
                let (even, odd) = pairs.fold((0, 0), |(even, odd), pair| {
                    (
                        even + usize::from(pair[0] == 0),
                        odd + usize::from(pair[1] == 0),
                    )
                });
                if even > count / 2 && odd < count / 5 {
                    return UTF_16BE;
                }
                if odd > count / 2 && even < count / 5 {
                    return UTF_16LE;
                }
            }
            if std::str::from_utf8(data).is_ok() {
                return UTF_8;
            }
            let mut detector = chardetng::EncodingDetector::new();
            detector.feed(data, true);
            detector.guess(None, true)
        });
    encoding.decode_without_bom_handling(data).0.into_owned()
}

fn decode_xml(data: &[u8]) -> String {
    let prefix = String::from_utf8_lossy(&data[..data.len().min(256)]);
    let charset = prefix
        .trim_start()
        .strip_prefix("<?xml")
        .and_then(|value| value.split_once("?>"))
        .and_then(|(value, _)| value.split_once("encoding"))
        .and_then(|(_, value)| value.trim_start().strip_prefix('='))
        .and_then(|value| {
            let value = value.trim_start();
            let delimiter = value.chars().next()?;
            matches!(delimiter, '\'' | '"').then_some(())?;
            value[1..].split(delimiter).next()
        });
    let mut xml = decode(data, charset);
    if let Some(start) = xml.find("<!DOCTYPE") {
        // Strip the declaration without reading its external identifier or expanding internal entities.
        let mut quote = None;
        let mut subset = 0_u32;
        for (offset, character) in xml[start..].char_indices() {
            match (quote, character) {
                (Some(delimiter), value) if delimiter == value => quote = None,
                (Some(_), _) => {}
                (None, '\'' | '"') => quote = Some(character),
                (None, '[') => subset += 1,
                (None, ']') => subset = subset.saturating_sub(1),
                (None, '>') if subset == 0 => {
                    xml.replace_range(start..start + offset + 1, "");
                    break;
                }
                _ => {}
            }
        }
    }
    xml
}

fn parse_xml(xml: &str) -> Result<Document<'_>> {
    Ok(Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 350_000,
            ..ParsingOptions::default()
        },
    )?)
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|node| node.has_tag_name(name))
}

fn node_text(node: Node<'_, '_>) -> Option<String> {
    let mut text = String::new();
    for part in node
        .descendants()
        .filter(|node| node.is_text())
        .filter_map(|node| node.text())
    {
        text.push_str(part);
    }
    clean(&text)
}

fn child_text(node: Node<'_, '_>, name: &str) -> Option<String> {
    child(node, name).and_then(node_text)
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean(text: &str) -> Option<String> {
    let text = collapse(text.trim_matches(['\u{feff}', '\0']));
    (!text.is_empty()).then_some(text)
}

fn markup_text(markup: &str) -> Option<String> {
    let document = kuchiki::parse_html().one(markup);
    clean(&document.text_contents())
}

fn snapshot_title(document: &NodeRef) -> Option<String> {
    document
        .select_first("h1, h2, h3, title")
        .ok()
        .and_then(|node| clean(&node.text_contents()))
}

fn inner_html(node: &NodeRef) -> Result<String> {
    let mut bytes = Vec::new();
    for item in node.children() {
        item.serialize(&mut bytes)?;
    }
    Ok(String::from_utf8(bytes)?)
}

fn markup_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn isbn(metadata: &mut Metadata, value: &str) {
    let label = value.trim();
    let lower = label.to_ascii_lowercase();
    let label = ["urn:isbn:", "isbn-13:", "isbn-10:", "isbn:"]
        .iter()
        .find(|prefix| lower.starts_with(**prefix))
        .map_or(label, |prefix| label[prefix.len()..].trim());
    let digits: String = label
        .chars()
        .filter(|c| *c != '-' && !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    match digits.len() {
        10 if digits.as_bytes()[..9].iter().all(u8::is_ascii_digit)
            && (digits.as_bytes()[9].is_ascii_digit() || digits.ends_with('X')) =>
        {
            metadata.isbn10.get_or_insert(digits);
        }
        13 if digits.bytes().all(|c| c.is_ascii_digit()) => {
            metadata.isbn13.get_or_insert(digits);
        }
        _ => {}
    }
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok()? {
        ImageFormat::Png => Some("image/png"),
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Gif => Some("image/gif"),
        ImageFormat::WebP => Some("image/webp"),
        ImageFormat::Bmp => Some("image/bmp"),
        ImageFormat::Avif => Some("image/avif"),
        _ => None,
    }
}

fn data_image(bytes: &[u8]) -> Option<String> {
    image_mime(bytes).map(|mime| format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

pub(crate) fn cover_image(bytes: &[u8]) -> Option<String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(96 * 1024 * 1024);
    reader.limits(limits);
    let thumbnail = reader.decode().ok()?.thumbnail(400, 400).into_rgb8();
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, 84)
        .encode_image(&thumbnail)
        .ok()?;
    data_image(&encoded)
}

fn chapter_href(index: usize, fragment: Option<&str>) -> String {
    match fragment.filter(|fragment| !fragment.is_empty()) {
        Some(fragment) => format!("deft-chapter:{index}{}", fragment_href(fragment)),
        None => format!("deft-chapter:{index}"),
    }
}

fn fragment_href(fragment: &str) -> String {
    format!(
        "#{}",
        percent_encoding::utf8_percent_encode(fragment, percent_encoding::NON_ALPHANUMERIC)
    )
}
