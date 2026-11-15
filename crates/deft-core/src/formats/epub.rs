use super::*;
use percent_encoding::percent_decode_str;
use std::collections::HashMap;

const CONTAINER: &str = "META-INF/container.xml";
const RIGHTS: [&str; 2] = ["META-INF/rights.xml", "META-INF/license.lcpl"];
const FONT_ALGORITHMS: [&str; 2] = [
    "http://www.idpf.org/2008/embedding",
    "http://ns.adobe.com/pdf/enc#RC",
];

#[derive(Debug)]
struct Item {
    path: String,
    media_type: String,
    properties: Vec<String>,
}

impl Item {
    fn property(&self, name: &str) -> bool {
        self.properties.iter().any(|property| property == name)
    }
}

struct Package {
    items: HashMap<String, Item>,
    spine: Vec<String>,
    metadata: Metadata,
    nav_path: Option<String>,
    ncx_path: Option<String>,
    cover_path: Option<String>,
}

pub(super) fn metadata(path: &Path) -> Result<Metadata> {
    let mut archive = open_zip(path)?;
    let protected = is_protected(&mut archive)?;
    // Some commercial EPUB packages hide all resources, including the package itself.
    if protected {
        let mut metadata = package(&mut archive)
            .map(|package| package.metadata)
            .unwrap_or_default();
        metadata.protected = true;
        return Ok(metadata);
    }
    let mut package = package(&mut archive)?;
    if let Some(cover) = package.cover_path {
        package.metadata.cover = zip_entry(&mut archive, &cover, ARCHIVE_IMAGE_LIMIT)
            .ok()
            .and_then(|bytes| cover_image(&bytes));
    }
    Ok(package.metadata)
}

pub(super) fn open(path: &Path) -> Result<Publication> {
    let mut archive = open_zip(path)?;
    ensure!(!is_protected(&mut archive)?, "{PROTECTED}");
    let package = package(&mut archive)?;
    let spine: Vec<_> = package
        .spine
        .iter()
        .filter_map(|id| package.items.get(id))
        .filter(|item| {
            item.media_type == "application/xhtml+xml"
                || item.media_type == "text/html"
                || item.media_type == "image/svg+xml"
        })
        .collect();
    let indices: HashMap<_, _> = spine
        .iter()
        .enumerate()
        .map(|(index, item)| (item.path.as_str(), index))
        .collect();
    let toc = read_toc(&mut archive, &package, &indices);
    let mut chapter_titles = HashMap::new();
    for entry in &toc {
        chapter_titles
            .entry(entry.chapter)
            .or_insert_with(|| entry.title.clone());
    }
    let mut chapters = Vec::with_capacity(spine.len());
    let mut publication_size = 0;
    let mut images = ImageCache::default();
    for (index, item) in spine.into_iter().enumerate() {
        let bytes = zip_entry(&mut archive, &item.path, TEXT_LIMIT)?;
        let (title, html) = if item.media_type == "image/svg+xml" {
            let html = stand_alone_svg(&decode_xml(&bytes), &mut archive, &item.path, &mut images)?;
            (None, html)
        } else {
            let document = kuchiki::parse_html().one(decode_xml(&bytes));
            let title = snapshot_title(&document);
            normalize_document(
                &document,
                &mut archive,
                &item.path,
                index,
                &indices,
                &mut images,
            )?;
            let body = document
                .select_first("body")
                .map_err(|_| anyhow::anyhow!("Invalid EPUB document."))?;
            (title, inner_html(body.as_node())?)
        };
        publication_size += html.len() as u64;
        ensure!(
            publication_size <= ASSET_LIMIT,
            "This book expands beyond the desktop reader's size limit."
        );
        chapters.push(Chapter {
            title: chapter_titles
                .remove(&index)
                .or(title)
                .unwrap_or_else(|| format!("chapter {}", index + 1)),
            html,
            href: Some(chapter_href(index, None)),
        });
    }
    Publication::text(chapters, toc, package.metadata.language)
}

fn is_protected(archive: &mut ZipArchive<File>) -> Result<bool> {
    if archive.file_names().any(|name| {
        RIGHTS
            .iter()
            .any(|marker| name.eq_ignore_ascii_case(marker))
    }) {
        return Ok(true);
    }
    let entry = archive
        .file_names()
        .find(|name| name.eq_ignore_ascii_case("META-INF/encryption.xml"))
        .map(str::to_owned);
    let Some(entry) = entry else { return Ok(false) };
    // Failing closed avoids sending encrypted resources into the reader.
    let Ok(bytes) = zip_entry(archive, &entry, XML_LIMIT) else {
        return Ok(true);
    };
    let xml = decode_xml(&bytes);
    let Ok(document) = parse_xml(&xml) else {
        return Ok(true);
    };
    Ok(document
        .descendants()
        .filter(|node| node.has_tag_name("EncryptionMethod"))
        .any(|node| {
            !node
                .attribute("Algorithm")
                .is_some_and(|algorithm| FONT_ALGORITHMS.contains(&algorithm))
        })
        || document
            .descendants()
            .filter(|node| node.has_tag_name("EncryptedData"))
            .any(|node| {
                !node
                    .descendants()
                    .any(|child| child.has_tag_name("EncryptionMethod"))
            }))
}

fn package(archive: &mut ZipArchive<File>) -> Result<Package> {
    let container = decode_xml(&zip_entry(archive, CONTAINER, XML_LIMIT)?);
    let document = parse_xml(&container).context("Invalid EPUB container document.")?;
    let package_path = document
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .and_then(|href| resolve_path("", href).map(|(path, _)| path))
        .context("The EPUB container doesn't locate a package.")?;
    let source = decode_xml(&zip_entry(archive, &package_path, XML_LIMIT)?);
    let document = parse_xml(&source).context("Invalid EPUB package document.")?;
    let root = document.root_element();
    ensure!(
        root.has_tag_name("package"),
        "The EPUB package is missing its root element."
    );
    let metadata = child(root, "metadata").context("The EPUB package is missing metadata.")?;
    let manifest = child(root, "manifest").context("The EPUB package is missing its manifest.")?;
    let spine = child(root, "spine").context("The EPUB package is missing its reading order.")?;
    let items: HashMap<_, _> = manifest
        .children()
        .filter(|node| node.has_tag_name("item"))
        .filter_map(|node| {
            let id = node.attribute("id")?.to_owned();
            let (path, _) = resolve_path(&package_path, node.attribute("href")?)?;
            let media_type = node.attribute("media-type").unwrap_or_default().to_owned();
            let properties = node
                .attribute("properties")
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            Some((
                id,
                Item {
                    path,
                    media_type,
                    properties,
                },
            ))
        })
        .collect();
    let nav_path = items
        .values()
        .find(|item| item.property("nav"))
        .map(|item| item.path.clone());
    let ncx_path = spine
        .attribute("toc")
        .and_then(|id| items.get(id))
        .or_else(|| {
            items
                .values()
                .find(|item| item.media_type == "application/x-dtbncx+xml")
        })
        .map(|item| item.path.clone());
    let cover_path = items
        .values()
        .find(|item| item.property("cover-image"))
        .or_else(|| named_meta(metadata, "cover").and_then(|id| items.get(id)))
        .map(|item| item.path.clone());
    let spine = spine
        .children()
        .filter(|node| node.has_tag_name("itemref"))
        .filter_map(|node| node.attribute("idref").map(str::to_owned))
        .collect();
    Ok(Package {
        items,
        spine,
        nav_path,
        ncx_path,
        cover_path,
        metadata: opf_metadata(metadata),
    })
}

fn named_meta<'a, 'input>(metadata: Node<'a, 'input>, name: &str) -> Option<&'a str> {
    metadata
        .children()
        .find(|node| node.has_tag_name("meta") && node.attribute("name") == Some(name))
        .and_then(|node| node.attribute("content"))
}

fn opf_metadata(metadata: Node<'_, '_>) -> Metadata {
    let mut result = Metadata {
        title: child_text(metadata, "title").unwrap_or_default(),
        authors: metadata
            .children()
            .filter(|node| node.has_tag_name("creator"))
            .filter_map(node_text)
            .collect(),
        language: child_text(metadata, "language"),
        publisher: child_text(metadata, "publisher"),
        published_date: child_text(metadata, "date"),
        description: child_text(metadata, "description")
            .as_deref()
            .and_then(markup_text),
        ..Metadata::default()
    };
    for identifier in metadata
        .children()
        .filter(|node| node.has_tag_name("identifier"))
        .filter_map(node_text)
    {
        isbn(&mut result, &identifier);
    }
    let meta: Vec<_> = metadata
        .children()
        .filter(|node| node.has_tag_name("meta"))
        .collect();
    for collection in meta
        .iter()
        .filter(|node| node.attribute("property") == Some("belongs-to-collection"))
    {
        let Some(id) = collection.attribute("id") else {
            continue;
        };
        let refinements = format!("#{id}");
        let info = |name| {
            meta.iter()
                .find(|node| {
                    node.attribute("property") == Some(name)
                        && node.attribute("refines") == Some(refinements.as_str())
                })
                .copied()
                .and_then(node_text)
        };
        if info("collection-type")
            .as_ref()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("series"))
        {
            result.series = node_text(*collection);
            result.series_index = info("group-position").as_deref().and_then(parse_position);
            break;
        }
    }
    if result.series.is_none() {
        result.series = named_meta(metadata, "calibre:series").and_then(clean);
        result.series_index = named_meta(metadata, "calibre:series_index").and_then(parse_position);
    }
    result
}

fn read_toc(
    archive: &mut ZipArchive<File>,
    package: &Package,
    indices: &HashMap<&str, usize>,
) -> Vec<TocEntry> {
    let entry = |base: &str, href: &str, title: String| {
        let (path, fragment) = resolve_path(base, href)?;
        let chapter = *indices.get(path.as_str())?;
        Some(TocEntry {
            title,
            chapter,
            href: Some(chapter_href(chapter, fragment.as_deref())),
        })
    };
    if let Some((path, bytes)) = package.nav_path.as_ref().and_then(|path| {
        zip_entry(archive, path, XML_LIMIT)
            .ok()
            .map(|bytes| (path, bytes))
    }) {
        let document = kuchiki::parse_html().one(decode_xml(&bytes));
        if let Ok(nav_nodes) = document.select("nav") {
            if let Some(nav) = nav_nodes
                .filter(|nav| {
                    let attributes = nav.attributes.borrow();
                    ["epub:type", "role", "type"].iter().any(|name| {
                        attributes.get(*name).is_some_and(|value| {
                            value
                                .split_whitespace()
                                .any(|role| role == "toc" || role == "doc-toc")
                        })
                    })
                })
                .next()
            {
                if let Ok(links) = nav.as_node().select("a[href]") {
                    let toc: Vec<_> = links
                        .filter_map(|link| {
                            entry(
                                path,
                                link.attributes.borrow().get("href")?,
                                clean(&link.text_contents())?,
                            )
                        })
                        .collect();
                    if !toc.is_empty() {
                        return toc;
                    }
                }
            }
        }
    }
    if let Some((path, bytes)) = package.ncx_path.as_ref().and_then(|path| {
        zip_entry(archive, path, XML_LIMIT)
            .ok()
            .map(|bytes| (path, bytes))
    }) {
        let xml = decode_xml(&bytes);
        if let Ok(document) = parse_xml(&xml) {
            return document
                .descendants()
                .filter(|node| node.has_tag_name("navPoint"))
                .filter_map(|node| {
                    let title =
                        child(node, "navLabel").and_then(|label| child_text(label, "text"))?;
                    entry(path, child(node, "content")?.attribute("src")?, title)
                })
                .collect();
        }
    }
    Vec::new()
}

fn resolve_path(base: &str, href: &str) -> Option<(String, Option<String>)> {
    let href = href.trim();
    if href.is_empty() || href.starts_with("//") {
        return None;
    }
    let (file, fragment) = href
        .split_once('#')
        .map_or((href, None), |(path, hash)| (path, Some(hash)));
    let file = file.split('?').next()?;
    let decoded = percent_decode_str(file).decode_utf8().ok()?;
    if decoded.contains([':', '\\', '\0']) || decoded.starts_with('/') {
        return None;
    }
    let file = if file.is_empty() {
        base.to_owned()
    } else {
        let mut parts: Vec<_> = base
            .rsplit_once('/')
            .map(|(parent, _)| parent.split('/').collect())
            .unwrap_or_default();
        for part in decoded.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop()?;
                }
                part => parts.push(part),
            }
        }
        parts.join("/")
    };
    let fragment = fragment.and_then(|value| {
        percent_decode_str(value)
            .decode_utf8()
            .ok()
            .map(|value| value.into_owned())
    });
    (!file.is_empty()).then_some((file, fragment))
}

#[derive(Default)]
struct ImageCache {
    images: HashMap<String, Option<String>>,
    size: u64,
}

impl ImageCache {
    fn load(
        &mut self,
        archive: &mut ZipArchive<File>,
        base: &str,
        source: &str,
    ) -> Result<Option<String>> {
        if let Some((path, _)) = resolve_path(base, source) {
            if !self.images.contains_key(&path) {
                let image = zip_entry(archive, &path, ARCHIVE_IMAGE_LIMIT)
                    .ok()
                    .as_deref()
                    .and_then(data_image);
                self.size += image.as_ref().map_or(0, |value| value.len()) as u64;
                ensure!(
                    self.size <= ASSET_LIMIT,
                    "This EPUB's images exceed the reader's size limit."
                );
                self.images.insert(path.clone(), image);
            }
            return Ok(self.images.get(&path).cloned().flatten());
        }
        // Honor raster data URLs already present in the EPUB.
        Ok(embedded_raster(source).then(|| source.to_owned()))
    }
}

fn embedded_raster(source: &str) -> bool {
    ["png", "jpeg", "gif", "webp", "bmp", "avif"]
        .iter()
        .any(|mime| source.starts_with(&format!("data:image/{mime};base64,")))
}

fn normalize_document(
    document: &NodeRef,
    archive: &mut ZipArchive<File>,
    base: &str,
    index: usize,
    indices: &HashMap<&str, usize>,
    images: &mut ImageCache,
) -> Result<()> {
    if let Ok(links) = document.select("a[href]") {
        for link in links {
            let mut attrs = link.attributes.borrow_mut();
            let target = attrs
                .get("href")
                .and_then(|href| resolve_path(base, href))
                .and_then(|(path, fragment)| {
                    let chapter = *indices.get(path.as_str())?;
                    Some(if chapter == index && fragment.is_some() {
                        fragment_href(fragment.as_deref().unwrap_or_default())
                    } else {
                        chapter_href(chapter, fragment.as_deref())
                    })
                });
            attrs.remove("href");
            if let Some(target) = target {
                attrs.insert("href", target);
            }
        }
    }
    if let Ok(nodes) = document.select("img") {
        for item in nodes {
            let mut attributes = item.attributes.borrow_mut();
            let source = attributes.get("src").unwrap_or_default();
            let asset = images.load(archive, base, source)?;
            attributes.remove("src");
            attributes.remove("srcset");
            attributes.remove("loading");
            if let Some(asset) = asset {
                attributes.insert("src", asset);
            }
        }
    }
    if let Ok(nodes) = document.select("svg") {
        let nodes: Vec<_> = nodes.collect();
        for node in nodes {
            if let Some(image) = node.as_node().descendants().find(|child| {
                child
                    .as_element()
                    .is_some_and(|element| element.name.local.as_ref() == "image")
            }) {
                if let Some(element) = image.as_element() {
                    let attributes = element.attributes.borrow();
                    let href = attributes
                        .map
                        .iter()
                        .find(|(name, _)| name.local.as_ref() == "href")
                        .map(|(_, value)| value.value.as_str())
                        .unwrap_or_default();
                    if let Some(asset) = images.load(archive, base, href)? {
                        // Most EPUB cover wrappers use a single raster inside SVG to scale the cover.
                        let replacement = kuchiki::parse_html()
                            .one(format!("<img src=\"{}\" alt=\"\">", markup_escape(&asset)));
                        if let Ok(image) = replacement.select_first("img") {
                            image.as_node().detach();
                            node.as_node().insert_before(image.as_node().clone());
                            node.as_node().detach();
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn stand_alone_svg(
    xml: &str,
    archive: &mut ZipArchive<File>,
    base: &str,
    images: &mut ImageCache,
) -> Result<String> {
    let document = kuchiki::parse_html().one(xml.to_owned());
    normalize_document(&document, archive, base, 0, &HashMap::new(), images)?;
    let body = document
        .select_first("body")
        .map_err(|_| anyhow::anyhow!("Invalid SVG document."))?;
    inner_html(body.as_node())
}
