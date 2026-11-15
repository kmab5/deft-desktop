use super::*;
use std::{
    collections::BTreeMap,
    io::{Seek, SeekFrom},
};

const PDB_HEADER: usize = 78;
const KINDLE_HEADER_LIMIT: u64 = 2 * 1024 * 1024;
const MOBI_HEADER_START: usize = 16;
const MISSING_INDEX: u32 = u32::MAX;

struct PalmBook<R> {
    reader: R,
    offsets: Vec<u64>,
    len: u64,
}

struct Header {
    data: Vec<u8>,
    records: BTreeMap<u32, Vec<std::ops::Range<usize>>>,
}

impl<R: Read + Seek> PalmBook<R> {
    fn read(mut reader: R) -> Result<Option<Self>> {
        let len = reader.seek(SeekFrom::End(0))?;
        reader.rewind()?;
        let mut prefix = [0; 16];
        let prefix_len = reader.read(&mut prefix)?;
        let prefix = &prefix[..prefix_len];
        if prefix.starts_with(b"CONT") || prefix.windows(6).any(|part| part == b"DRMION") {
            return Ok(None);
        }
        reader.rewind()?;
        let mut raw = [0; PDB_HEADER];
        reader
            .read_exact(&mut raw)
            .context("Invalid Kindle document.")?;
        ensure!(
            &raw[60..68] == b"BOOKMOBI",
            "Missing MOBI document signature."
        );
        let count = read_u16(&raw, 76).unwrap_or_default() as usize;
        ensure!(
            count > 0 && len >= (PDB_HEADER + count * 8) as u64,
            "Invalid MOBI record table."
        );
        let mut table = vec![0; count * 8];
        reader.read_exact(&mut table)?;
        let offsets: Vec<_> = table
            .chunks_exact(8)
            .filter_map(|entry| read_u32(entry, 0).map(u64::from))
            .collect();
        ensure!(
            offsets[0] >= (PDB_HEADER + table.len()) as u64
                && offsets[count - 1] <= len
                && offsets.windows(2).all(|pair| pair[0] <= pair[1]),
            "Invalid MOBI record offsets."
        );
        Ok(Some(Self {
            reader,
            offsets,
            len,
        }))
    }

    fn record(&mut self, index: usize, limit: u64) -> Result<Vec<u8>> {
        let start = *self.offsets.get(index).context("Missing MOBI record.")?;
        let end = self.offsets.get(index + 1).copied().unwrap_or(self.len);
        let size = end - start;
        ensure!(
            size <= limit,
            "MOBI resource exceeds the reader's size limit."
        );
        self.reader.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; size as usize];
        self.reader.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    fn headers(&mut self) -> Result<(Header, Option<Header>)> {
        let first = Header::read(self.record(0, KINDLE_HEADER_LIMIT)?)?;
        let second = first
            .index(121)
            .and_then(|index| self.record(index, KINDLE_HEADER_LIMIT).ok())
            .and_then(|bytes| Header::read(bytes).ok());
        Ok((first, second))
    }
}

impl Header {
    fn read(data: Vec<u8>) -> Result<Self> {
        ensure!(
            data.get(MOBI_HEADER_START..MOBI_HEADER_START + 4) == Some(b"MOBI"),
            "Missing MOBI header."
        );
        let header_len = read_u32(&data, 20).context("Invalid MOBI header.")? as usize;
        ensure!(
            header_len >= 20 && header_len <= data.len() - MOBI_HEADER_START,
            "Invalid MOBI header size."
        );
        let mut records: BTreeMap<u32, Vec<_>> = BTreeMap::new();
        if read_u32(&data, 128).is_some_and(|flags| flags & 0x40 != 0) {
            let start = header_len + MOBI_HEADER_START;
            if data.get(start..start + 4) == Some(b"EXTH") {
                let len = read_u32(&data, start + 4).unwrap_or(0) as usize;
                let count = read_u32(&data, start + 8).unwrap_or(0) as usize;
                let end = start.saturating_add(len).min(data.len());
                let mut offset = start + 12;
                for _ in 0..count {
                    if offset + 8 > end {
                        break;
                    }
                    let kind = read_u32(&data, offset).unwrap_or_default();
                    let size = read_u32(&data, offset + 4).unwrap_or_default() as usize;
                    if size < 8 || size > end - offset {
                        break;
                    }
                    records
                        .entry(kind)
                        .or_default()
                        .push(offset + 8..offset + size);
                    offset += size;
                }
            }
        }
        Ok(Self { data, records })
    }

    fn protected(&self) -> bool {
        read_u16(&self.data, 12).unwrap_or(1) != 0
    }

    fn charset(&self) -> Option<&'static str> {
        match read_u32(&self.data, 28) {
            Some(1252) => Some("windows-1252"),
            Some(65001) => Some("utf-8"),
            _ => None,
        }
    }

    fn first(&self, kind: u32) -> Option<&[u8]> {
        let range = self.records.get(&kind)?.first()?.clone();
        self.data.get(range)
    }

    fn index(&self, kind: u32) -> Option<usize> {
        let index = read_u32(self.first(kind)?, 0)?;
        (index != MISSING_INDEX).then_some(index as usize)
    }

    fn record_text(&self, kind: u32) -> Option<String> {
        self.first(kind)
            .and_then(|bytes| clean(&decode(bytes, self.charset())))
    }

    fn title(&self) -> Option<String> {
        self.record_text(503)
            .or_else(|| {
                let start = read_u32(&self.data, 84)? as usize;
                let count = read_u32(&self.data, 88)? as usize;
                let bytes = self.data.get(start..start.checked_add(count)?)?;
                clean(&decode(bytes, self.charset()))
            })
            .as_deref()
            .and_then(markup_text)
    }

    fn metadata(&self) -> Metadata {
        let mut metadata = Metadata {
            title: self.title().unwrap_or_default(),
            authors: self
                .records
                .get(&100)
                .into_iter()
                .flatten()
                .filter_map(|range| {
                    self.data
                        .get(range.clone())
                        .and_then(|bytes| markup_text(&decode(bytes, self.charset())))
                })
                .collect(),
            publisher: self.record_text(101).as_deref().and_then(markup_text),
            published_date: self.record_text(106),
            description: self.record_text(103).as_deref().and_then(markup_text),
            language: self
                .record_text(524)
                .or_else(|| mobi_language(*self.data.get(95)?).map(str::to_owned)),
            ..Metadata::default()
        };
        if let Some(value) = self.record_text(104) {
            isbn(&mut metadata, &value);
        }
        metadata
    }
}

pub(super) fn metadata(path: &Path) -> Result<Metadata> {
    let Some(mut book) = PalmBook::read(File::open(path)?)? else {
        return Ok(Metadata {
            protected: true,
            ..Metadata::default()
        });
    };
    let (first, second) = book.headers()?;
    let current = second.as_ref().unwrap_or(&first);
    let mut metadata = current.metadata();
    metadata.protected = first.protected() || current.protected();
    if !metadata.protected {
        let index = current
            .index(201)
            .or_else(|| current.index(202))
            .or_else(|| first.index(201))
            .or_else(|| first.index(202));
        let base = read_u32(&first.data, 108)
            .filter(|base| *base != MISSING_INDEX)
            .map(|index| index as usize);
        metadata.cover = base
            .zip(index)
            .and_then(|(base, index)| base.checked_add(index))
            .and_then(|index| book.record(index, ARCHIVE_IMAGE_LIMIT).ok())
            .as_deref()
            .and_then(cover_image);
    }
    Ok(metadata)
}

fn check(reader: impl Read + Seek) -> Result<()> {
    let Some(mut book) = PalmBook::read(reader)? else {
        bail!("{PROTECTED}");
    };
    let (first, second) = book.headers()?;
    ensure!(
        !first.protected() && !second.as_ref().is_some_and(Header::protected),
        "{PROTECTED}"
    );
    Ok(())
}

pub(super) fn open(path: &Path) -> Result<Publication> {
    check(File::open(path)?)?;
    Ok(Publication::fixed("mobi", None))
}

pub(super) fn asset(path: &Path) -> Result<Vec<u8>> {
    let bytes = read_file(path, BINARY_LIMIT)?;
    check(Cursor::new(bytes.as_slice()))?;
    Ok(bytes)
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn mobi_language(id: u8) -> Option<&'static str> {
    match id {
        0x01 => Some("ar"),
        0x02 => Some("bg"),
        0x03 => Some("ca"),
        0x04 => Some("zh"),
        0x05 => Some("cs"),
        0x06 => Some("da"),
        0x07 => Some("de"),
        0x08 => Some("el"),
        0x09 => Some("en"),
        0x0a => Some("es"),
        0x0b => Some("fi"),
        0x0c => Some("fr"),
        0x0d => Some("he"),
        0x0e => Some("hu"),
        0x10 => Some("it"),
        0x11 => Some("ja"),
        0x12 => Some("ko"),
        0x13 => Some("nl"),
        0x14 => Some("no"),
        0x15 => Some("pl"),
        0x16 => Some("pt"),
        0x18 => Some("ro"),
        0x19 => Some("ru"),
        0x1a => Some("hr"),
        0x1b => Some("sk"),
        0x1d => Some("sv"),
        0x1e => Some("th"),
        0x1f => Some("tr"),
        0x22 => Some("uk"),
        0x29 => Some("fa"),
        0x39 => Some("hi"),
        0x45 => Some("bn"),
        0x5e => Some("am"),
        _ => None,
    }
}
