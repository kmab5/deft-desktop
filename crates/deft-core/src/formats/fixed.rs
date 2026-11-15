use super::*;
use lopdf::{Dictionary, Document as PdfDocument, Object};
use std::cmp::Ordering;

pub(super) fn cbz_metadata(path: &Path) -> Result<Metadata> {
    let mut archive = open_zip(path)?;
    let pages = comic_pages(&archive);
    ensure!(
        !pages.is_empty(),
        "This comic archive contains no supported images."
    );
    let mut metadata = Metadata {
        page_count: Some(pages.len()),
        ..Metadata::default()
    };
    let mut cover = 0;
    let comic_info = archive
        .file_names()
        .find(|entry| {
            entry
                .rsplit('/')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("ComicInfo.xml"))
        })
        .map(str::to_owned);
    if let Some(bytes) =
        comic_info.and_then(|name| zip_optional(&mut archive, &name, XML_LIMIT).ok().flatten())
    {
        let xml = decode_xml(&bytes);
        if let Ok(document) = parse_xml(&xml) {
            let root = document.root_element();
            metadata.title = child_text(root, "Title").unwrap_or_default();
            metadata.authors = child_text(root, "Writer")
                .map(|author| author_list(&author, [',', ';']))
                .unwrap_or_default();
            metadata.series = child_text(root, "Series");
            metadata.series_index = child_text(root, "Number")
                .as_deref()
                .and_then(parse_position);
            metadata.language = child_text(root, "LanguageISO");
            metadata.publisher = child_text(root, "Publisher");
            metadata.description = child_text(root, "Summary");
            metadata.published_date = comic_date(root);
            if let Some(value) = child_text(root, "GTIN") {
                isbn(&mut metadata, &value);
            }
            cover = root
                .descendants()
                .find(|node| {
                    node.has_tag_name("Page") && node.attribute("Type") == Some("FrontCover")
                })
                .and_then(|node| node.attribute("Image")?.parse::<usize>().ok())
                .filter(|index| *index < pages.len())
                .unwrap_or(0);
        }
    }
    metadata.cover = zip_entry(&mut archive, &pages[cover], ARCHIVE_IMAGE_LIMIT)
        .ok()
        .as_deref()
        .and_then(cover_image);
    Ok(metadata)
}

fn comic_date(root: Node<'_, '_>) -> Option<String> {
    let year = child_text(root, "Year")?
        .parse::<u16>()
        .ok()
        .filter(|year| *year > 0)?;
    let month = child_text(root, "Month")
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|month| (1..=12).contains(month));
    let day = child_text(root, "Day")
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|day| (1..=31).contains(day));
    Some(match (month, day) {
        (Some(month), Some(day)) => format!("{year:04}-{month:02}-{day:02}"),
        (Some(month), _) => format!("{year:04}-{month:02}"),
        _ => format!("{year:04}"),
    })
}

pub(super) fn open_cbz(path: &Path) -> Result<Publication> {
    let archive = open_zip(path)?;
    let count = comic_pages(&archive).len();
    ensure!(
        count > 0,
        "This comic archive contains no supported images."
    );
    Ok(Publication::fixed("images", Some(count)))
}

pub(super) fn cbz_asset(path: &Path, index: usize) -> Result<Vec<u8>> {
    let mut archive = open_zip(path)?;
    let pages = comic_pages(&archive);
    let name = pages.get(index).context("Comic page is out of range.")?;
    let data = zip_entry(&mut archive, name, ARCHIVE_IMAGE_LIMIT)?;
    ensure!(
        image_mime(&data).is_some(),
        "Comic page is not a supported raster image."
    );
    Ok(data)
}

fn comic_pages(archive: &ZipArchive<File>) -> Vec<String> {
    let mut pages: Vec<_> = archive
        .file_names()
        .filter(|name| {
            !name
                .split('/')
                .any(|part| part.starts_with('.') || part == "__MACOSX")
                && name.rsplit_once('.').is_some_and(|(_, extension)| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "jpg" | "jpeg" | "jfif" | "png" | "webp" | "gif" | "bmp" | "avif"
                    )
                })
        })
        .map(str::to_owned)
        .collect();
    pages.sort_by_cached_key(|name| (natural_key(name), name.clone()));
    pages
}

#[derive(PartialEq, Eq)]
enum SortPart {
    Word(String),
    Number(String),
}

impl PartialOrd for SortPart {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SortPart {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Number(a), Self::Number(b)) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
            (Self::Word(a), Self::Word(b)) => a.cmp(b),
            (Self::Number(_), Self::Word(_)) => Ordering::Less,
            (Self::Word(_), Self::Number(_)) => Ordering::Greater,
        }
    }
}

fn natural_key(name: &str) -> Vec<SortPart> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut numeric = name.as_bytes().first().is_some_and(u8::is_ascii_digit);
    let mut add = |part: &str, numeric| {
        parts.push(if numeric {
            SortPart::Number(part.trim_start_matches('0').to_owned())
        } else {
            SortPart::Word(part.to_lowercase())
        });
    };
    for (index, character) in name.char_indices() {
        if character.is_ascii_digit() != numeric {
            add(&name[start..index], numeric);
            numeric = !numeric;
            start = index;
        }
    }
    add(&name[start..], numeric);
    parts
}

pub(super) fn check_pdf_header(path: &Path) -> Result<()> {
    let mut file = File::open(path)?;
    let mut prefix = [0; 1024];
    let count = file.read(&mut prefix)?;
    ensure!(
        prefix[..count].windows(5).any(|magic| magic == b"%PDF-"),
        "Invalid PDF document."
    );
    Ok(())
}

pub(super) fn pdf_metadata(path: &Path) -> Result<Metadata> {
    check_pdf_header(path)?;
    ensure!(
        path.metadata()?.len() <= ASSET_LIMIT,
        "This PDF is too large to inspect."
    );
    let document = PdfDocument::load(path).context("Invalid PDF document.")?;
    let mut metadata = Metadata::default();
    if let Ok(encryption) = document.get_encrypted() {
        // Password-based PDF encryption uses the Standard security handler. Leave its password entry to PDF.js.
        let filter = encryption
            .get(b"Filter")
            .ok()
            .and_then(|value| value.as_name().ok());
        if filter != Some(b"Standard") {
            metadata.protected = true;
            return Ok(metadata);
        }
    }
    let info = document
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| resolve_pdf_object(&document, object))
        .and_then(|object| object.as_dict().ok());
    let get = |field| info.and_then(|dictionary| pdf_text(&document, dictionary, field));
    let pages = document.get_pages().len();
    metadata.title = get(b"Title").unwrap_or_default();
    metadata.authors = get(b"Author")
        .map(|author| author_list(&author, [';']))
        .unwrap_or_default();
    metadata.description = get(b"Subject");
    metadata.publisher = get(b"Publisher");
    metadata.published_date = get(b"CreationDate").and_then(|date| normalize_pdf_date(&date));
    metadata.page_count = (pages > 0).then_some(pages);
    metadata.language = document
        .catalog()
        .ok()
        .and_then(|dictionary| pdf_text(&document, dictionary, b"Lang"));
    if let Some(value) = get(b"ISBN") {
        isbn(&mut metadata, &value);
    }
    if let Some(xmp) = document
        .catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Metadata").ok())
        .and_then(|object| resolve_pdf_object(&document, object))
        .and_then(|object| object.as_stream().ok())
        .filter(|stream| {
            stream.content.len() as u64 <= XML_LIMIT && stream.dict.get(b"Filter").is_err()
        })
    {
        let xml = decode_xml(&xmp.content);
        add_xmp(&xml, &mut metadata);
    }
    Ok(metadata)
}

fn resolve_pdf_object<'a>(document: &'a PdfDocument, object: &'a Object) -> Option<&'a Object> {
    if let Ok(reference) = object.as_reference() {
        document.get_object(reference).ok()
    } else {
        Some(object)
    }
}

fn pdf_text(document: &PdfDocument, dictionary: &Dictionary, field: &[u8]) -> Option<String> {
    let value = resolve_pdf_object(document, dictionary.get(field).ok()?)?;
    lopdf::decode_text_string(value)
        .ok()
        .as_deref()
        .and_then(clean)
}

fn normalize_pdf_date(date: &str) -> Option<String> {
    let date = date.strip_prefix("D:").unwrap_or(date);
    let digits: Vec<_> = date
        .bytes()
        .take_while(u8::is_ascii_digit)
        .take(8)
        .collect();
    let digits = std::str::from_utf8(&digits).ok()?;
    if digits.len() >= 8 {
        return Some(format!(
            "{}-{}-{}",
            &digits[..4],
            &digits[4..6],
            &digits[6..8]
        ));
    }
    if digits.len() >= 4 {
        return Some(digits[..4].to_owned());
    }
    None
}

fn add_xmp(xml: &str, metadata: &mut Metadata) {
    let Ok(document) = parse_xml(xml) else {
        return;
    };
    let dc = "http://purl.org/dc/elements/1.1/";
    let property = |name| {
        document
            .descendants()
            .find(|node| node.has_tag_name((dc, name)))
    };
    let values = |name| {
        property(name)
            .map(|node| {
                let items: Vec<_> = node
                    .descendants()
                    .filter(|item| item.has_tag_name("li"))
                    .filter_map(node_text)
                    .collect();
                if items.is_empty() {
                    node_text(node).into_iter().collect()
                } else {
                    items
                }
            })
            .unwrap_or_default()
    };
    let first = |name| values(name).into_iter().next();
    if metadata.title.is_empty() {
        metadata.title = first("title").unwrap_or_default();
    }
    if metadata.authors.is_empty() {
        metadata.authors = values("creator");
    }
    if metadata.description.is_none() {
        metadata.description = first("description");
    }
    if metadata.publisher.is_none() {
        metadata.publisher = first("publisher");
    }
    if metadata.published_date.is_none() {
        metadata.published_date = first("date");
    }
    if metadata.language.is_none() {
        metadata.language = first("language");
    }
    for value in values("identifier") {
        isbn(metadata, &value);
    }
}

fn author_list<const N: usize>(authors: &str, separators: [char; N]) -> Vec<String> {
    authors.split(separators).filter_map(clean).collect()
}

pub(super) fn open_pdf(path: &Path) -> Result<Publication> {
    check_pdf_header(path)?;
    // The viewer handles passwords and obtains the page count lazily.
    Ok(Publication::fixed("pdf", None))
}
