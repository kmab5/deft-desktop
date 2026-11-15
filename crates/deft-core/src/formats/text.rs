use super::*;
use std::collections::HashMap;

pub(super) fn open_txt(path: &Path) -> Result<Publication> {
    let data = read_file(path, TEXT_LIMIT)?;
    let text = decode(&data, None);
    ensure!(
        text.chars()
            .any(|value| !value.is_whitespace() && !value.is_control()),
        "The text file is empty."
    );
    let mut chapters = Vec::new();
    let mut current = String::new();
    let mut heading = filename_metadata(path).title;
    let mut previous_blank = true;
    let mut paragraph = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            flush_paragraph(&mut current, &mut paragraph);
        } else if previous_blank && chapter_heading(line) {
            flush_paragraph(&mut current, &mut paragraph);
            finish_chapter(&mut chapters, &heading, &mut current);
            heading = line.to_owned();
            current.push_str("<h2>");
            current.push_str(&markup_escape(line));
            current.push_str("</h2>");
        } else {
            if !paragraph.is_empty() {
                paragraph.push(' ');
            }
            paragraph.push_str(line);
            if paragraph.len() >= 12_000 {
                flush_paragraph(&mut current, &mut paragraph);
            }
            if current.len() >= 24_000 && paragraph.is_empty() {
                finish_chapter(&mut chapters, &heading, &mut current);
                heading = format!("section {}", chapters.len() + 1);
            }
        }
        previous_blank = line.is_empty();
    }
    flush_paragraph(&mut current, &mut paragraph);
    finish_chapter(&mut chapters, &heading, &mut current);
    Publication::text(chapters, Vec::new(), None)
}

fn flush_paragraph(chapter: &mut String, paragraph: &mut String) {
    if paragraph.is_empty() {
        return;
    }
    chapter.push_str("<p>");
    chapter.push_str(&markup_escape(paragraph));
    chapter.push_str("</p>");
    paragraph.clear();
}

fn finish_chapter(chapters: &mut Vec<Chapter>, heading: &str, html: &mut String) {
    if !html.is_empty() {
        chapters.push(Chapter {
            title: heading.to_owned(),
            html: std::mem::take(html),
            href: None,
        });
    }
}

fn chapter_heading(line: &str) -> bool {
    if line.len() > 90 || line.ends_with(['?', '!', ',', ';']) {
        return false;
    }
    let lower = line.trim_end_matches(['.', ':']).to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "prologue" | "epilogue" | "preface" | "afterword" | "introduction"
    ) {
        return true;
    }
    let Some((keyword, remaining)) = lower.split_once(' ') else {
        return false;
    };
    if !matches!(
        keyword,
        "chapter" | "part" | "book" | "act" | "section" | "scene"
    ) {
        return false;
    }
    let index = remaining
        .trim_start()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .next()
        .unwrap_or_default();
    !index.is_empty()
        && (index.bytes().all(|byte| byte.is_ascii_digit())
            || index.bytes().all(|byte| b"ivxlcdm".contains(&byte))
            || matches!(
                index,
                "one"
                    | "two"
                    | "three"
                    | "four"
                    | "five"
                    | "six"
                    | "seven"
                    | "eight"
                    | "nine"
                    | "ten"
                    | "eleven"
                    | "twelve"
            ))
}

fn fb2_source(path: &Path) -> Result<String> {
    let extension = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let bytes = if extension.ends_with(".fb2.zip") {
        let mut archive = open_zip(path)?;
        let name = archive
            .file_names()
            .find(|entry| entry.to_ascii_lowercase().ends_with(".fb2"))
            .map(str::to_owned)
            .context("The archive doesn't contain a FictionBook file.")?;
        zip_entry(&mut archive, &name, TEXT_LIMIT)?
    } else {
        read_file(path, TEXT_LIMIT)?
    };
    Ok(decode_xml(&bytes))
}

pub(super) fn fb2_metadata(path: &Path) -> Result<Metadata> {
    let xml = fb2_source(path)?;
    let document = parse_xml(&xml).context("Invalid FictionBook XML.")?;
    let root = document.root_element();
    ensure!(
        root.has_tag_name("FictionBook"),
        "This file isn't a FictionBook."
    );
    let source = child(root, "description");
    let title = source.and_then(|description| child(description, "title-info"));
    let publish = source.and_then(|description| child(description, "publish-info"));
    let series = title.and_then(|title| child(title, "sequence"));
    let mut metadata = Metadata {
        title: title
            .and_then(|node| child_text(node, "book-title"))
            .unwrap_or_default(),
        authors: title.map_or_else(Vec::new, |node| {
            node.children()
                .filter(|child| child.has_tag_name("author"))
                .filter_map(fb2_author)
                .collect()
        }),
        series: series
            .and_then(|sequence| sequence.attribute("name"))
            .and_then(clean),
        series_index: series
            .and_then(|sequence| sequence.attribute("number"))
            .and_then(parse_position),
        language: title.and_then(|node| child_text(node, "lang")),
        publisher: publish.and_then(|node| child_text(node, "publisher")),
        published_date: publish
            .and_then(|node| child_text(node, "year"))
            .or_else(|| {
                let node = title.and_then(|title| child(title, "date"))?;
                node.attribute("value")
                    .and_then(clean)
                    .or_else(|| node_text(node))
            }),
        description: title.and_then(|node| child_text(node, "annotation")),
        ..Metadata::default()
    };
    if let Some(value) = publish.and_then(|node| child_text(node, "isbn")) {
        isbn(&mut metadata, &value);
    }
    metadata.cover = title
        .and_then(|node| child(node, "coverpage"))
        .and_then(|node| child(node, "image"))
        .and_then(href)
        .and_then(|source| source.strip_prefix('#'))
        .and_then(|id| {
            root.children()
                .find(|node| node.has_tag_name("binary") && node.attribute("id") == Some(id))
        })
        .and_then(decode_fb2_image)
        .as_deref()
        .and_then(cover_image);
    Ok(metadata)
}

fn fb2_author(node: Node<'_, '_>) -> Option<String> {
    let name = ["first-name", "middle-name", "last-name"]
        .iter()
        .filter_map(|field| child_text(node, field))
        .collect::<Vec<_>>()
        .join(" ");
    clean(&name).or_else(|| child_text(node, "nickname"))
}

fn href<'a, 'input>(node: Node<'a, 'input>) -> Option<&'a str> {
    node.attributes()
        .find(|attribute| attribute.name() == "href")
        .map(|attribute| attribute.value())
}

fn decode_fb2_image(node: Node<'_, '_>) -> Option<Vec<u8>> {
    let text = node.text()?;
    if text.len() as u64 > ARCHIVE_IMAGE_LIMIT * 2 {
        return None;
    }
    let base64: String = text
        .chars()
        .filter(|value| !value.is_ascii_whitespace())
        .collect();
    STANDARD
        .decode(base64)
        .ok()
        .filter(|value| value.len() as u64 <= ARCHIVE_IMAGE_LIMIT)
}

pub(super) fn open_fb2(path: &Path) -> Result<Publication> {
    let xml = fb2_source(path)?;
    let document = parse_xml(&xml).context("Invalid FictionBook XML.")?;
    let root = document.root_element();
    ensure!(
        root.has_tag_name("FictionBook"),
        "This file isn't a FictionBook."
    );
    let mut groups = Vec::new();
    for body in root.children().filter(|node| node.has_tag_name("body")) {
        let sections: Vec<_> = body
            .children()
            .filter(|node| node.has_tag_name("section"))
            .collect();
        if sections.is_empty() {
            groups.push(body);
        } else {
            groups.extend(
                body.children()
                    .filter(|node| node.is_element() && !node.has_tag_name("title")),
            );
        }
    }
    let mut anchors = HashMap::new();
    for (index, section) in groups.iter().enumerate() {
        for id in section
            .descendants()
            .filter_map(|node| node.attribute("id"))
        {
            anchors.entry(id).or_insert(index);
        }
    }
    let images: HashMap<_, _> = root
        .children()
        .filter(|node| node.has_tag_name("binary"))
        .filter_map(|node| Some((node.attribute("id")?, node)))
        .collect();
    let mut image_cache = HashMap::new();
    let mut chapters = Vec::new();
    let mut publication_size = 0;
    for (index, group) in groups.into_iter().enumerate() {
        let mut html = String::new();
        let title = child_text(group, "title").unwrap_or_else(|| format!("chapter {}", index + 1));
        let context = Fb2Context {
            index,
            anchors: &anchors,
            images: &images,
        };
        render_fb2(group, &context, &mut image_cache, &mut html, 0)?;
        publication_size += html.len() as u64;
        ensure!(
            publication_size <= ASSET_LIMIT,
            "This book expands beyond the desktop reader's size limit."
        );
        chapters.push(Chapter {
            title,
            html,
            href: Some(chapter_href(index, None)),
        });
    }
    let language = child(root, "description")
        .and_then(|node| child(node, "title-info"))
        .and_then(|node| child_text(node, "lang"));
    Publication::text(chapters, Vec::new(), language)
}

struct Fb2Context<'a, 'input> {
    index: usize,
    anchors: &'a HashMap<&'a str, usize>,
    images: &'a HashMap<&'a str, Node<'a, 'input>>,
}

fn render_fb2<'a>(
    node: Node<'a, '_>,
    context: &Fb2Context<'a, '_>,
    images: &mut HashMap<&'a str, Option<String>>,
    html: &mut String,
    depth: usize,
) -> Result<()> {
    ensure!(
        html.len() as u64 <= ASSET_LIMIT && depth <= 160,
        "FictionBook content is too deeply nested or large."
    );
    if let Some(text) = node.text().filter(|_| node.is_text()) {
        html.push_str(&markup_escape(text));
        return Ok(());
    }
    if !node.is_element() {
        return Ok(());
    }
    let name = node.tag_name().name();
    if name == "empty-line" {
        html.push_str("<br>");
        return Ok(());
    }
    if name == "image" {
        if let Some(id) = href(node).and_then(|value| value.strip_prefix('#')) {
            let source = images.entry(id).or_insert_with(|| {
                context
                    .images
                    .get(id)
                    .copied()
                    .and_then(decode_fb2_image)
                    .as_deref()
                    .and_then(data_image)
            });
            if let Some(source) = source {
                html.push_str("<img alt=\"");
                html.push_str(&markup_escape(node.attribute("alt").unwrap_or_default()));
                html.push_str("\" src=\"");
                html.push_str(source);
                html.push_str("\">");
            }
        }
        return Ok(());
    }
    let tag = match name {
        "body" | "section" | "poem" | "stanza" => "section",
        "title" => "h2",
        "subtitle" => "h3",
        "p" if node
            .parent_element()
            .is_some_and(|parent| parent.has_tag_name("title")) =>
        {
            "span"
        }
        "p" | "v" => "p",
        "strong" | "sup" | "sub" | "code" | "table" | "tr" | "td" | "th" | "a" => name,
        "emphasis" => "em",
        "strikethrough" => "s",
        "cite" | "epigraph" => "blockquote",
        "text-author" => "cite",
        _ => "span",
    };
    html.push('<');
    html.push_str(tag);
    if let Some(id) = node.attribute("id") {
        html.push_str(" id=\"");
        html.push_str(&markup_escape(id));
        html.push('"');
    }
    if tag == "a" {
        if let Some(id) = href(node).and_then(|value| value.strip_prefix('#')) {
            if let Some(index) = context.anchors.get(id) {
                let target = if *index == context.index {
                    fragment_href(id)
                } else {
                    chapter_href(*index, Some(id))
                };
                html.push_str(" href=\"");
                html.push_str(&markup_escape(&target));
                html.push('"');
            }
        }
    }
    html.push('>');
    for child in node.children() {
        render_fb2(child, context, images, html, depth + 1)?;
    }
    html.push_str("</");
    html.push_str(tag);
    html.push('>');
    Ok(())
}
