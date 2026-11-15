use super::*;
use djvu_bzz::bzz_decode;
use percent_encoding::percent_decode_str;
use std::{
    collections::HashMap,
    io::{Seek, SeekFrom},
};

struct Chunk {
    kind: [u8; 4],
    start: u64,
    end: u64,
}

impl Chunk {
    fn length(&self) -> u64 {
        self.end - self.start
    }

    fn bytes(&self, file: &mut File) -> Result<Vec<u8>> {
        ensure!(
            self.length() <= XML_LIMIT,
            "DjVu metadata resource is too large."
        );
        file.seek(SeekFrom::Start(self.start))?;
        read_limited(file.take(self.length()), XML_LIMIT)
    }
}

struct DjVu {
    bundled: bool,
    pages: Option<usize>,
    metadata: String,
    toc: Vec<TocEntry>,
}

pub(super) fn metadata(path: &Path) -> Result<Metadata> {
    let djvu = inspect(path, false)?;
    let field = |name| metadata_field(&djvu.metadata, name);
    let mut metadata = Metadata {
        title: field("title").unwrap_or_default(),
        authors: field("author")
            .map(|authors| authors.split(';').filter_map(clean).collect())
            .unwrap_or_default(),
        publisher: field("publisher"),
        language: field("language"),
        description: field("description").or_else(|| field("subject")),
        published_date: field("year"),
        page_count: djvu.pages,
        ..Metadata::default()
    };
    if let Some(value) = field("isbn") {
        isbn(&mut metadata, &value);
    }
    Ok(metadata)
}

pub(super) fn open(path: &Path) -> Result<Publication> {
    let djvu = inspect(path, true)?;
    ensure!(
        djvu.bundled,
        "This DjVu references separate files. Open a bundled DjVu to read it in Deft."
    );
    let mut publication = Publication::fixed("djvu", djvu.pages);
    publication.toc = djvu.toc;
    Ok(publication)
}

fn inspect(path: &Path, include_toc: bool) -> Result<DjVu> {
    let mut file = File::open(path)?;
    let mut header = [0; 16];
    file.read_exact(&mut header)
        .context("Invalid DjVu document.")?;
    ensure!(&header[..8] == b"AT&TFORM", "Invalid DjVu document.");
    let is_single_page = match &header[12..] {
        b"DJVU" => true,
        b"DJVM" => false,
        _ => bail!("Unsupported DjVu document type."),
    };
    let end = 12 + u32::from_be_bytes(header[8..12].try_into()?) as u64;
    ensure!(
        end <= file.metadata()?.len() && end >= 16,
        "Invalid DjVu document length."
    );
    let chunks = chunks(&mut file, 16, end)?;
    let mut bundled = is_single_page;
    let mut directory = None;
    if let Some(chunk) = chunks.iter().find(|chunk| chunk.kind == *b"DIRM") {
        let data = chunk.bytes(&mut file)?;
        bundled = data.first().is_some_and(|flags| flags & 0x80 != 0);
        if include_toc || !bundled {
            directory = parse_directory(&data);
        }
    }
    let mut forms = Vec::new();
    for chunk in chunks
        .iter()
        .filter(|chunk| chunk.kind == *b"FORM" && chunk.length() >= 4)
    {
        file.seek(SeekFrom::Start(chunk.start))?;
        let mut form_type = [0; 4];
        file.read_exact(&mut form_type)?;
        forms.push((form_type, chunk));
    }
    let pages = if is_single_page {
        Some(1)
    } else if bundled {
        Some(forms.iter().filter(|(kind, _)| *kind == *b"DJVU").count()).filter(|count| *count > 0)
    } else {
        directory.as_ref().map(|directory| directory.page_count)
    };
    let metadata = annotation_metadata(&mut file, &chunks)
        .or_else(|| {
            // A bundled document can keep common metadata in a shared annotation FORM.
            forms
                .iter()
                .filter(|(kind, _)| *kind == *b"DJVI" || *kind == *b"DJVU")
                .take(16)
                .find_map(|(_, form)| {
                    let children = self::chunks(&mut file, form.start + 4, form.end).ok()?;
                    annotation_metadata(&mut file, &children)
                })
        })
        .unwrap_or_default();
    let toc = if include_toc {
        chunks
            .iter()
            .find(|chunk| chunk.kind == *b"NAVM")
            .and_then(|chunk| chunk.bytes(&mut file).ok())
            .and_then(|data| decompress(&data))
            .map(|data| parse_toc(&data, directory.as_ref(), pages))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(DjVu {
        bundled,
        pages,
        metadata,
        toc,
    })
}

fn chunks(file: &mut File, mut offset: u64, end: u64) -> Result<Vec<Chunk>> {
    let mut found = Vec::new();
    while offset + 8 <= end {
        ensure!(
            found.len() < 100_000,
            "DjVu document contains too many chunks."
        );
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let length = u32::from_be_bytes(header[4..].try_into()?) as u64;
        let start = offset + 8;
        let chunk_end = start + length;
        ensure!(chunk_end <= end, "Invalid DjVu chunk length.");
        found.push(Chunk {
            kind: header[..4].try_into()?,
            start,
            end: chunk_end,
        });
        offset = chunk_end + (length % 2);
    }
    Ok(found)
}

fn decompress(data: &[u8]) -> Option<Vec<u8>> {
    bzz_decode(data)
        .ok()
        .filter(|decoded| decoded.len() as u64 <= XML_LIMIT)
}

fn annotation_metadata(file: &mut File, chunks: &[Chunk]) -> Option<String> {
    chunks
        .iter()
        .filter(|chunk| matches!(&chunk.kind, b"ANTa" | b"ANTz"))
        .find_map(|chunk| {
            let bytes = chunk.bytes(file).ok()?;
            let payload = if chunk.kind == *b"ANTz" {
                decompress(&bytes)?
            } else {
                bytes
            };
            let text = decode(&payload, None);
            let start = text.find("(metadata")?;
            Some(text[start..].to_owned())
        })
}

fn metadata_field(annotation: &str, name: &str) -> Option<String> {
    let (_, value) = annotation.split_once(&format!("({name}"))?;
    let value = value
        .strip_prefix(char::is_whitespace)?
        .trim_start()
        .strip_prefix('"')?;
    let mut unescaped = String::new();
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            unescaped.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            return clean(&unescaped);
        } else {
            unescaped.push(character);
        }
    }
    None
}

struct Directory {
    names: HashMap<String, usize>,
    page_count: usize,
}

fn parse_directory(data: &[u8]) -> Option<Directory> {
    let flags = *data.first()?;
    // Version 0 used a different preamble. Its numeric TOC still resolves by index.
    if flags & 0x7f == 0 {
        return None;
    }
    let count = u16::from_be_bytes(data.get(1..3)?.try_into().ok()?) as usize;
    let offset = if flags & 0x80 != 0 { 3 + count * 4 } else { 3 };
    let metadata = decompress(data.get(offset..)?)?;
    let kinds = metadata.get(count * 3..count * 4)?;
    let mut strings = metadata.get(count * 4..)?.split(|byte| *byte == 0);
    let mut names = HashMap::new();
    let mut page_count = 0;
    for kind in kinds {
        let id = strings.next()?;
        let file_name = if kind & 0x80 != 0 {
            strings.next()?
        } else {
            id
        };
        let title = if kind & 0x40 != 0 {
            strings.next()?
        } else {
            id
        };
        if kind & 0x3f == 1 {
            for value in [id, file_name, title]
                .into_iter()
                .filter(|value| !value.is_empty())
            {
                names.entry(decode(value, None)).or_insert(page_count);
            }
            page_count += 1;
        }
    }
    Some(Directory { names, page_count })
}

fn parse_toc(data: &[u8], directory: Option<&Directory>, pages: Option<usize>) -> Vec<TocEntry> {
    let Some((header, mut entries)) = data.split_first_chunk::<2>() else {
        return Vec::new();
    };
    let mut toc = Vec::new();
    for _ in 0..u16::from_be_bytes(*header) {
        // The child count describes nesting. A flat display can keep the preorder already on disk.
        let Some((_, rest)) = entries.split_first() else {
            break;
        };
        let Some((title, rest)) = navm_string(rest) else {
            break;
        };
        let Some((target, rest)) = navm_string(rest) else {
            break;
        };
        entries = rest;
        let target = target.strip_prefix('#').unwrap_or(&target);
        let target = percent_decode_str(target).decode_utf8_lossy();
        let page = target
            .parse::<usize>()
            .ok()
            .and_then(|number| number.checked_sub(1))
            .or_else(|| {
                directory.and_then(|directory| directory.names.get(target.as_ref()).copied())
            });
        if let (Some(chapter), Some(title)) = (page, clean(&title)) {
            if pages.is_none_or(|count| chapter < count) {
                toc.push(TocEntry {
                    title,
                    chapter,
                    href: None,
                });
            }
        }
    }
    toc
}

fn navm_string(data: &[u8]) -> Option<(String, &[u8])> {
    let (head, rest) = data.split_first_chunk::<3>()?;
    let length = u32::from_be_bytes([0, head[0], head[1], head[2]]) as usize;
    let (word, rest) = rest.split_at_checked(length)?;
    Some((decode(word, None), rest))
}
