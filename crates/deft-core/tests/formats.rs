use base64::{engine::general_purpose::STANDARD, Engine};
use deft_core::formats::{self, Metadata};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use std::{
    fs,
    io::{Cursor, Write},
    path::Path,
};
use tempfile::tempdir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn archive(path: &Path, items: &[(&str, &[u8])]) {
    let mut archive = ZipWriter::new(fs::File::create(path).unwrap());
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, bytes) in items {
        archive.start_file(*name, options).unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive.finish().unwrap();
}

fn image(color: [u8; 3]) -> Vec<u8> {
    let mut png = Cursor::new(Vec::new());
    let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 3, Rgb(color)));
    source.write_to(&mut png, ImageFormat::Png).unwrap();
    png.into_inner()
}

#[test]
fn recognizes_aliases_and_filename_metadata() {
    for (file, kind) in [
        ("B.EPUB", "epub"),
        ("a.prc", "mobi"),
        ("B.kf8", "azw3"),
        ("a.fb2.ZIP", "fb2"),
        ("x.djv", "djvu"),
    ] {
        assert_eq!(formats::format(Path::new(file)), Some(kind));
    }
    assert_eq!(formats::format(Path::new("x.rtf")), None);
    let series = formats::filename_metadata(Path::new(
        "Mistborn - 02.5 - The Well of Ascension [retail].epub",
    ));
    assert_eq!(series.title, "The Well of Ascension");
    assert_eq!(series.series.as_deref(), Some("Mistborn"));
    assert_eq!(series.series_index, Some(2.5));
    let series = formats::filename_metadata(Path::new("The Final Empire (Mistborn #1).fb2.zip"));
    assert_eq!(series.title, "The Final Empire");
    assert_eq!(series.series_index, Some(1.0));
    assert_eq!(
        formats::filename_metadata(Path::new("Ursula K. Le Guin - Earthsea.djvu")).authors,
        ["Ursula K. Le Guin"]
    );
}

const CONTAINER: &[u8] = br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>"#;
const OPF: &[u8] = br##"
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
  <metadata>
    <dc:title>Paper Worlds</dc:title><dc:creator>First Author</dc:creator><dc:creator>Second Author</dc:creator>
    <dc:language>en</dc:language><dc:identifier>urn:isbn:9780765326355</dc:identifier>
    <meta id="series" property="belongs-to-collection">Paper series</meta>
    <meta property="collection-type" refines="#series">series</meta>
    <meta property="group-position" refines="#series">2.5</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="one" href="chapters/one.xhtml" media-type="application/xhtml+xml"/>
    <item id="two" href="chapters/two.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover%20art.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="one"/><itemref idref="two"/></spine>
</package>"##;

#[test]
fn epub_resolves_metadata_spine_images_and_internal_links() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("Example.epub");
    let png = image([12, 34, 88]);
    archive(&path, &[
        ("META-INF/container.xml", CONTAINER),
        ("OPS/book.opf", OPF),
        ("OPS/nav.xhtml", br##"<html><body><nav epub:type="toc"><ol><li><a href="chapters/one.xhtml">Opening</a></li><li><a href="chapters/two.xhtml#end">Closing</a></li></ol></nav></body></html>"##),
        ("OPS/chapters/one.xhtml", br##"<html><body><h1>One</h1><a href="two.xhtml#end">Jump</a><img src="../cover%20art.png"/><img src="https://example.invalid/image.png"/></body></html>"##),
        ("OPS/chapters/two.xhtml", br##"<html><body><h1 id="end">The end</h1></body></html>"##),
        ("OPS/cover art.png", &png),
    ]);
    let Metadata {
        title,
        authors,
        series,
        series_index,
        isbn13,
        cover,
        ..
    } = formats::metadata(&path, "epub").unwrap();
    assert_eq!(title, "Paper Worlds");
    assert_eq!(authors, ["First Author", "Second Author"]);
    assert_eq!(series.as_deref(), Some("Paper series"));
    assert_eq!(series_index, Some(2.5));
    assert_eq!(isbn13.as_deref(), Some("9780765326355"));
    assert!(cover.unwrap().starts_with("data:image/jpeg;base64,"));
    let publication = formats::open(&path, "epub").unwrap();
    assert_eq!(publication.language.as_deref(), Some("en"));
    assert_eq!(publication.chapters.len(), 2);
    assert_eq!(publication.toc[1].title, "Closing");
    assert_eq!(
        publication.toc[1].href.as_deref(),
        Some("deft-chapter:1#end")
    );
    assert!(publication.chapters[0].html.contains("deft-chapter:1#end"));
    assert!(publication.chapters[0]
        .html
        .contains("data:image/png;base64,"));
    assert!(!publication.chapters[0].html.contains("example.invalid"));
}

#[test]
fn epub_drm_and_font_obfuscation_are_distinguished() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("example.epub");
    let lock = |algorithm: &str| {
        format!("<encryption><EncryptedData><EncryptionMethod Algorithm=\"{algorithm}\"/></EncryptedData></encryption>")
    };
    for (algorithm, protected) in [
        ("http://www.idpf.org/2008/embedding", false),
        ("http://ns.adobe.com/pdf/enc#RC", false),
        ("http://www.w3.org/2001/04/xmlenc#aes128-cbc", true),
    ] {
        archive(
            &path,
            &[
                ("META-INF/container.xml", CONTAINER),
                ("OPS/book.opf", OPF),
                ("META-INF/encryption.xml", lock(algorithm).as_bytes()),
            ],
        );
        assert_eq!(
            formats::metadata(&path, "epub").unwrap().protected,
            protected
        );
    }
    assert!(formats::open(&path, "epub")
        .unwrap_err()
        .to_string()
        .contains("DRM-protected"));
    archive(&path, &[("META-INF/license.lcpl", b"{}")]);
    assert!(formats::metadata(&path, "epub").unwrap().protected);
    fs::write(&path, b"not a zip").unwrap();
    assert!(formats::metadata(&path, "epub").is_err());
}

#[test]
fn text_decodes_utf16_and_escapes_literal_markup() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("A Book.txt");
    let original = "Chapter I\r\n\r\nCafé & <script>\r\n\r\nChapter II\r\n\r\nSecond section.";
    let bytes: Vec<_> = [0xff, 0xfe]
        .into_iter()
        .chain(original.encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    fs::write(&path, bytes).unwrap();
    let publication = formats::open(&path, "txt").unwrap();
    assert_eq!(publication.chapters.len(), 2);
    assert!(publication.chapters[0]
        .html
        .contains("Café &amp; &lt;script&gt;"));
    assert_eq!(publication.chapters[1].title, "Chapter II");
}

#[test]
fn zipped_fictionbook_preserves_metadata_notes_and_illustrations() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("Book.fb2.zip");
    let xml = format!(
        r##"<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
        <description><title-info><book-title>Stories</book-title><author><first-name>Jane</first-name><last-name>Reader</last-name></author>
        <lang>en</lang><sequence name="Fiction" number="3"/><coverpage><image l:href="#cover"/></coverpage></title-info></description>
        <body><section><title><p>First</p></title><p>A phrase<a l:href="#n1">[1]</a><image l:href="#cover"/></p></section></body>
        <body name="notes"><section id="n1"><title><p>Note</p></title><p>Some context</p></section></body>
        <binary content-type="image/png" id="cover">{}</binary></FictionBook>"##,
        STANDARD.encode(image([20, 240, 40]))
    );
    archive(&path, &[("data/Book.fb2", xml.as_bytes())]);
    let metadata = formats::metadata(&path, "fb2").unwrap();
    assert_eq!(metadata.title, "Stories");
    assert_eq!(metadata.authors, ["Jane Reader"]);
    assert_eq!(metadata.series_index, Some(3.0));
    assert!(metadata.cover.is_some());
    let publication = formats::open(&path, "fb2").unwrap();
    assert_eq!(publication.chapters.len(), 2);
    assert!(publication.chapters[0].html.contains("deft-chapter:1#n1"));
    assert!(publication.chapters[0]
        .html
        .contains("data:image/png;base64,"));
}

#[test]
fn comic_pages_use_numeric_order_and_ignore_archive_artifacts() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("Comics.cbz");
    let first = image([200, 0, 0]);
    let second = image([0, 200, 0]);
    archive(&path, &[("page-10.png", &second), ("page-2.png", &first), ("__MACOSX/page-1.png", &second), ("ComicInfo.xml", br#"<ComicInfo><Title>Comic</Title><Writer>A. Writer, B. Writer</Writer><Year>2026</Year><Month>11</Month></ComicInfo>"#)]);
    assert_eq!(formats::open(&path, "cbz").unwrap().page_count, Some(2));
    assert_eq!(formats::asset(&path, "cbz", Some(0)).unwrap(), first);
    assert_eq!(formats::asset(&path, "cbz", Some(1)).unwrap(), second);
    assert!(formats::asset(&path, "cbz", Some(2)).is_err());
    let metadata = formats::metadata(&path, "cbz").unwrap();
    assert_eq!(metadata.authors, ["A. Writer", "B. Writer"]);
    assert_eq!(metadata.published_date.as_deref(), Some("2026-11"));
    assert!(metadata.cover.is_some());
}

fn put_u16(data: &mut [u8], offset: usize, value: u16) {
    data[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}
fn put_u32(data: &mut [u8], offset: usize, value: u32) {
    data[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn palm_book(encryption: u16) -> Vec<u8> {
    let mut data = vec![0; 86];
    data[60..68].copy_from_slice(b"BOOKMOBI");
    put_u16(&mut data, 76, 1);
    put_u32(&mut data, 78, 86);
    let mut record = vec![0; 244];
    put_u16(&mut record, 0, 1);
    put_u16(&mut record, 12, encryption);
    record[16..20].copy_from_slice(b"MOBI");
    put_u32(&mut record, 20, 228);
    put_u32(&mut record, 28, 65001);
    put_u32(&mut record, 128, 0x40);
    record.extend_from_slice(b"EXTH");
    let values: [(u32, &[u8]); 3] = [
        (503, b"Kindle Book"),
        (100, b"Alex Reader"),
        (104, b"9780765326355"),
    ];
    let exth_size = 12
        + values
            .iter()
            .map(|(_, value)| value.len() + 8)
            .sum::<usize>();
    record.extend_from_slice(&(exth_size as u32).to_be_bytes());
    record.extend_from_slice(&(values.len() as u32).to_be_bytes());
    for (kind, value) in values {
        record.extend_from_slice(&kind.to_be_bytes());
        record.extend_from_slice(&((value.len() + 8) as u32).to_be_bytes());
        record.extend_from_slice(value);
    }
    data.extend_from_slice(&record);
    data
}

#[test]
fn kindle_extracts_exth_and_refuses_protected_bytes() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("Kindle.azw3");
    let clear = palm_book(0);
    fs::write(&path, &clear).unwrap();
    let metadata = formats::metadata(&path, "azw3").unwrap();
    assert_eq!(metadata.title, "Kindle Book");
    assert_eq!(metadata.authors, ["Alex Reader"]);
    assert_eq!(metadata.isbn13.as_deref(), Some("9780765326355"));
    assert_eq!(formats::open(&path, "azw3").unwrap().kind, "mobi");
    assert_eq!(formats::asset(&path, "azw3", None).unwrap(), clear);
    fs::write(&path, palm_book(2)).unwrap();
    assert!(formats::metadata(&path, "azw3").unwrap().protected);
    assert!(formats::asset(&path, "azw3", None).is_err());
    fs::write(&path, b"CONT\0\0\0\0\0\0\0\0\0\0\0\0").unwrap();
    assert!(formats::metadata(&path, "azw3").unwrap().protected);
}

#[test]
fn pdf_extracts_document_info_and_djvu_inspects_bundled_pages() {
    use lopdf::{dictionary, Document, Object};

    let directory = tempdir().unwrap();
    let path = directory.path().join("Document.pdf");
    let mut pdf = Document::with_version("1.5");
    let pages = pdf.new_object_id();
    let page = pdf.add_object(dictionary! { "Type" => "Page", "Parent" => pages });
    pdf.objects.insert(
        pages,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1,
        }),
    );
    let catalog = pdf.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    let info = pdf.add_object(dictionary! { "Title" => Object::string_literal("A Document"), "Author" => Object::string_literal("A. Writer") });
    pdf.trailer.set("Root", catalog);
    pdf.trailer.set("Info", info);
    pdf.save(&path).unwrap();
    let metadata = formats::metadata(&path, "pdf").unwrap();
    assert_eq!(metadata.title, "A Document");
    assert_eq!(metadata.authors, ["A. Writer"]);
    assert_eq!(metadata.page_count, Some(1));
    assert!(formats::asset(&path, "pdf", None)
        .unwrap()
        .starts_with(b"%PDF"));

    let path = directory.path().join("scan.djv");
    let annotation = b"(metadata (title \"A scan\") (author \"A. Writer\"))";
    let mut djvu = b"AT&TFORM\0\0\0\0DJVUANTa\0\0\0\0".to_vec();
    put_u32(&mut djvu, 8, (12 + annotation.len()) as u32);
    put_u32(&mut djvu, 20, annotation.len() as u32);
    djvu.extend_from_slice(annotation);
    fs::write(&path, djvu).unwrap();
    let metadata = formats::metadata(&path, "djvu").unwrap();
    assert_eq!(metadata.title, "A scan");
    assert_eq!(metadata.page_count, Some(1));
    assert_eq!(formats::open(&path, "djvu").unwrap().kind, "djvu");
}

fn djvu_chunk(data: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
    data.extend_from_slice(kind);
    data.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    data.extend_from_slice(payload);
    if payload.len() % 2 != 0 {
        data.push(0);
    }
}

#[test]
fn djvu_decodes_compressed_annotations_and_resolves_named_outline_pages() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("Book.djvu");
    // Per-file metadata is six size bytes, two flags, then the null-terminated names.
    let mut pages = vec![0, 0, 0, 0, 0, 0, 1, 1];
    pages.extend_from_slice(b"page-a.djvu\0page-b.djvu\0");
    let mut dirm = vec![0x81, 0, 2];
    dirm.extend_from_slice(&[0; 8]);
    dirm.extend(djvu_bzz::bzz_encode(&pages));
    let annotation =
        djvu_bzz::bzz_encode(b"(metadata (title \"Scanned Book\") (author \"A Writer\"))");
    let mut navm = vec![0, 2];
    for (children, title, target) in [(1, "Opening", "#1"), (0, "Closing", "#page-b.djvu")] {
        navm.push(children);
        for text in [title, target] {
            navm.extend_from_slice(&(text.len() as u32).to_be_bytes()[1..]);
            navm.extend_from_slice(text.as_bytes());
        }
    }
    let mut body = b"DJVM".to_vec();
    djvu_chunk(&mut body, b"DIRM", &dirm);
    djvu_chunk(&mut body, b"NAVM", &djvu_bzz::bzz_encode(&navm));
    let mut shared = b"DJVI".to_vec();
    djvu_chunk(&mut shared, b"ANTz", &annotation);
    djvu_chunk(&mut body, b"FORM", &shared);
    djvu_chunk(&mut body, b"FORM", b"DJVU");
    djvu_chunk(&mut body, b"FORM", b"DJVU");
    let mut djvu = b"AT&T".to_vec();
    djvu_chunk(&mut djvu, b"FORM", &body);
    fs::write(&path, djvu).unwrap();

    let metadata = formats::metadata(&path, "djvu").unwrap();
    assert_eq!(metadata.title, "Scanned Book");
    assert_eq!(metadata.authors, ["A Writer"]);
    assert_eq!(metadata.page_count, Some(2));
    let publication = formats::open(&path, "djvu").unwrap();
    assert_eq!(publication.toc.len(), 2);
    assert_eq!(publication.toc[1].title, "Closing");
    assert_eq!(publication.toc[1].chapter, 1);
}
