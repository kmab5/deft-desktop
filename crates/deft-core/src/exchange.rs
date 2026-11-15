// SPDX-License-Identifier: GPL-3.0-only
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use chrono::{DateTime, Local, NaiveDate, SecondsFormat, TimeDelta, Utc};
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const BACKUP_SCHEMA_VERSION: u64 = 1;
const MAX_DB_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";
const WEEKLY_PREFIX: &str = "deft-weekly-";

const GOODREADS_COLUMNS: [&str; 24] = [
    "Book Id",
    "Title",
    "Author",
    "Author l-f",
    "Additional Authors",
    "ISBN",
    "ISBN13",
    "My Rating",
    "Average Rating",
    "Publisher",
    "Binding",
    "Number of Pages",
    "Year Published",
    "Original Publication Year",
    "Date Read",
    "Date Added",
    "Bookshelves",
    "Bookshelves with positions",
    "Exclusive Shelf",
    "My Review",
    "Spoiler",
    "Private Notes",
    "Read Count",
    "Owned Copies",
];

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn str_value(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    str_value(&value[key])
}

fn raw_int(value: &Value) -> String {
    value.as_i64().map(|n| n.to_string()).unwrap_or_default()
}

fn timestamp(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(value.as_i64()?)
}

fn iso_date(value: &Value) -> Value {
    timestamp(value)
        .map(|date| Value::String(date.to_rfc3339_opts(SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}

fn goodreads_date(value: &Value, offset: Option<i64>) -> String {
    timestamp(value)
        .and_then(|date| {
            date.checked_add_signed(TimeDelta::minutes(offset.unwrap_or(0).clamp(-840, 840)))
        })
        .map(|date| date.format("%Y/%m/%d").to_string())
        .unwrap_or_default()
}

fn option(options: &Value, key: &str, default: bool) -> bool {
    options[key].as_bool().unwrap_or(default)
}

fn is_ignored(book: &Value) -> bool {
    book["ignored"].as_bool().unwrap_or(false)
}

fn edition(book: &Value) -> Option<&Value> {
    book.get("edition").filter(|value| value.is_object())
}

pub fn unmatched_count(state: &Value) -> usize {
    array(&state["books"])
        .iter()
        .filter(|book| !is_ignored(book) && edition(book).is_none())
        .count()
}

fn book_state(book: &Value, history: &[&Value]) -> &'static str {
    // State is derived from the latest read-through. The vector preserves insertion
    // order so editing historical dates cannot make an earlier attempt current.
    let raw_state = history
        .last()
        .map(|entry| text(entry, "outcome"))
        .unwrap_or_else(|| text(book, "state"));
    match raw_state.to_ascii_lowercase().as_str() {
        "finished" => "finished",
        "abandoned" => "abandoned",
        "paused" => "paused",
        "reading" | "in_progress" => "reading",
        _ => "not_started",
    }
}

fn exclusive_shelf(state: &str) -> &'static str {
    match state {
        "finished" => "read",
        "reading" | "paused" => "currently-reading",
        "abandoned" => "did-not-finish",
        _ => "to-read",
    }
}

fn slug(name: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            if separator && !result.is_empty() {
                result.push('-');
            }
            result.push(c);
            separator = false;
        } else {
            separator = true;
        }
    }
    result
}

fn last_first(name: &str) -> String {
    if name.contains(',') {
        return name.to_owned();
    }
    name.rsplit_once(' ')
        .map(|(first, last)| format!("{last}, {first}"))
        .unwrap_or_else(|| name.to_owned())
}

fn year_in_string(value: &str) -> String {
    value
        .as_bytes()
        .windows(4)
        .find(|digits| digits.iter().all(u8::is_ascii_digit))
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .unwrap_or_default()
        .to_owned()
}

fn latest_finish<'a>(history: &'a [&Value]) -> Option<&'a Value> {
    history
        .iter()
        .copied()
        .filter(|entry| text(entry, "outcome").eq_ignore_ascii_case("finished"))
        .max_by_key(|entry| entry["endedAt"].as_i64().unwrap_or_default())
}

fn safe_cell(value: &str) -> String {
    let first = value.trim_start_matches(' ').chars().next();
    if matches!(first, Some('=' | '+' | '-' | '@' | '\t' | '\n' | '\r')) {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

fn isbn_cell(value: &Value, digits: usize) -> String {
    let isbn: String = str_value(value)
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if isbn.len() != digits
        || isbn
            .chars()
            .enumerate()
            .any(|(i, c)| c == 'X' && (digits != 10 || i != 9))
    {
        return String::new();
    }
    // Goodreads uses this form to preserve leading zeroes in spreadsheet programs.
    format!("=\"{isbn}\"")
}

fn index_by_book(values: &[Value]) -> HashMap<&str, Vec<&Value>> {
    let mut index = HashMap::<_, Vec<_>>::new();
    for value in values {
        index.entry(text(value, "bookId")).or_default().push(value);
    }
    index
}

fn credited_time(sessions: &[&Value]) -> u64 {
    sessions
        .iter()
        .filter(|session| !session["browsing"].as_bool().unwrap_or(false))
        .filter_map(|session| session["activeSeconds"].as_u64())
        .sum()
}

fn csv_binding(matched: &Value) -> String {
    let binding = text(matched, "binding");
    if !binding.is_empty() {
        return safe_cell(binding);
    }
    "ebook".into()
}

pub fn goodreads(state: &Value, options: &Value) -> Result<Vec<u8>> {
    let mut writer = csv::WriterBuilder::new()
        .terminator(csv::Terminator::CRLF)
        .from_writer(Vec::new());
    writer.write_record(GOODREADS_COLUMNS)?;
    let histories = index_by_book(array(&state["readThroughs"]));
    let mut shelves_by_book = HashMap::<&str, BTreeMap<String, String>>::new();

    for category in array(&state["categories"]) {
        let name = slug(text(category, "name"));
        if name.is_empty() {
            continue;
        }
        for member in array(&category["members"]) {
            let position = member["position"]
                .as_f64()
                .filter(|value| *value > 0.0)
                .map(|value| value.to_string())
                .unwrap_or_default();
            shelves_by_book
                .entry(text(member, "bookId"))
                .or_default()
                .entry(name.clone())
                .or_insert(position);
        }
    }

    for book in array(&state["books"]) {
        let matched = edition(book);
        if is_ignored(book) || (matched.is_none() && option(options, "matchedOnly", true)) {
            continue;
        }
        let book_id = text(book, "id");
        let matched = matched.unwrap_or(&Value::Null);
        let metadata = &book["metadata"];
        let identifier_source = if matched.is_object() {
            matched
        } else {
            metadata
        };
        let authors = array(&book["authors"]);
        let author = authors.first().map(str_value).unwrap_or_default();
        let additional_authors = authors
            .iter()
            .skip(1)
            .map(str_value)
            .collect::<Vec<_>>()
            .join(", ");
        let history = histories
            .get(book_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let shelf = exclusive_shelf(book_state(book, history));
        let shelves = shelves_by_book.get(book_id);
        let bookshelves = shelves
            .into_iter()
            .flat_map(|entries| entries.keys())
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let shelf_positions = shelves
            .into_iter()
            .flat_map(|entries| entries.iter())
            .map(|(name, position)| {
                if position.is_empty() {
                    name.clone()
                } else {
                    format!("{name} (#{position})")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let finished_count = history
            .iter()
            .filter(|entry| text(entry, "outcome").eq_ignore_ascii_case("finished"))
            .count();
        let rating = book["rating"]
            .as_f64()
            .filter(|rating| (0.5..=5.0).contains(rating))
            .map(|rating| (rating.round() as u8).to_string())
            .unwrap_or_else(|| "0".into());
        let review = if option(options, "includeReviews", false) {
            safe_cell(text(book, "review"))
        } else {
            String::new()
        };
        let date_read = latest_finish(history)
            .map(|entry| goodreads_date(&entry["endedAt"], entry["zoneOffsetMinutes"].as_i64()))
            .unwrap_or_default();
        let publication_year = matched["year"]
            .as_i64()
            .or_else(|| matched["publishedYear"].as_i64())
            .map(|value| value.to_string())
            .unwrap_or_else(|| year_in_string(text(metadata, "publishedDate")));
        let goodreads_id = matched["goodreadsId"]
            .as_u64()
            .map(|v| v.to_string())
            .or_else(|| {
                matched["goodreadsId"]
                    .as_str()
                    .filter(|v| v.chars().all(|c| c.is_ascii_digit()))
                    .map(str::to_owned)
            })
            .unwrap_or_default();

        writer.write_record([
            goodreads_id,
            safe_cell(text(book, "title")),
            safe_cell(author),
            safe_cell(&last_first(author)),
            safe_cell(&additional_authors),
            isbn_cell(&identifier_source["isbn10"], 10),
            isbn_cell(&identifier_source["isbn13"], 13),
            rating,
            raw_int(&matched["averageRating"]),
            safe_cell(
                matched["publisher"]
                    .as_str()
                    .unwrap_or_else(|| text(metadata, "publisher")),
            ),
            csv_binding(matched),
            matched["pages"]
                .as_u64()
                .or_else(|| metadata["pageCount"].as_u64())
                .map(|v| v.to_string())
                .unwrap_or_default(),
            publication_year,
            raw_int(&matched["originalYear"]),
            date_read,
            goodreads_date(&book["addedAt"], None),
            bookshelves,
            shelf_positions,
            shelf.into(),
            review,
            String::new(),
            String::new(),
            finished_count.to_string(),
            "1".into(),
        ])?;
    }
    writer
        .into_inner()
        .context("Could not finalize the Goodreads CSV")
}

fn session_pages(session: &Value) -> u64 {
    let position = |locator: &Value| -> Option<u64> {
        locator["page"]
            .as_u64()
            .or_else(|| locator["position"].as_u64())
    };
    session["pagesRead"]
        .as_u64()
        .or_else(|| {
            position(&session["startLocator"])
                .zip(position(&session["endLocator"]))
                .map(|(start, end)| end.saturating_sub(start))
        })
        .unwrap_or_default()
}

fn public_edition(value: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    for key in [
        "provider",
        "isbn10",
        "isbn13",
        "workId",
        "editionId",
        "openLibraryWorkId",
        "openLibraryEditionId",
        "googleBooksId",
        "hardcoverId",
        "goodreadsId",
        "title",
        "authors",
        "year",
        "publishedYear",
        "pages",
    ] {
        if let Some(field) = value.get(key).filter(|field| !field.is_null()) {
            fields.insert(key.into(), field.clone());
        }
    }
    Value::Object(fields)
}

fn public_notes(values: &[&Value]) -> Vec<Value> {
    values
        .iter()
        .map(|note| {
            json!({
                "type": note["kind"],
                "text": note["text"].as_str().unwrap_or_default(),
                "note": note["note"].as_str().unwrap_or_default(),
                "color": note["color"].as_str().unwrap_or_default(),
                "createdAt": iso_date(&note["createdAt"]),
                "updatedAt": iso_date(&note["updatedAt"]),
            })
        })
        .collect()
}

pub fn profile(state: &Value, options: &Value) -> Result<Vec<u8>> {
    let histories = index_by_book(array(&state["readThroughs"]));
    let sessions = index_by_book(array(&state["sessions"]));
    let notes = index_by_book(array(&state["annotations"]));
    let include_notes = option(options, "includeNotes", false);
    let include_reviews = option(options, "includeReviews", false);
    let mut books_by_id = HashMap::new();
    let mut authors = BTreeMap::<&str, Vec<&str>>::new();
    let mut books = Vec::new();
    let mut finished_read_throughs = 0;
    let mut overall_seconds = 0u64;
    let mut overall_sessions = 0;
    let mut overall_pages = 0u64;

    for book in array(&state["books"])
        .iter()
        .filter(|book| !is_ignored(book))
    {
        let id = text(book, "id");
        let book_sessions = sessions.get(id).map(Vec::as_slice).unwrap_or_default();
        let history = histories.get(id).map(Vec::as_slice).unwrap_or_default();
        let active_seconds = credited_time(book_sessions);
        books_by_id.insert(id, book);
        for author in array(&book["authors"]).iter().filter_map(Value::as_str) {
            let ids = authors.entry(author).or_default();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let mut exported = json!({
            "id": id,
            "title": text(book, "title"),
            "authors": array(&book["authors"]),
            "edition": edition(book).map(public_edition),
            "format": text(book, "format"),
            "state": book_state(book, history),
            "rating": book["rating"],
            "favorite": book["favorite"].as_bool().unwrap_or(false),
            "readThroughs": history.iter().map(|entry| {
                json!({
                    "id": entry["id"],
                    "startedAt": iso_date(&entry["startedAt"]),
                    "endedAt": iso_date(&entry["endedAt"]),
                    "outcome": book_state(&Value::Null, &[*entry]),
                })
            }).collect::<Vec<_>>(),
            "totalActiveSeconds": active_seconds,
        });
        if include_reviews {
            if let Some(review) = book["review"].as_str().filter(|v| !v.is_empty()) {
                exported["review"] = Value::String(review.to_owned());
            }
        }
        if include_notes {
            exported["notes"] = json!(public_notes(
                notes.get(id).map(Vec::as_slice).unwrap_or_default()
            ));
        }
        books.push(exported);
        finished_read_throughs += history
            .iter()
            .filter(|entry| text(entry, "outcome").eq_ignore_ascii_case("finished"))
            .count();
        overall_seconds += active_seconds;
        for session in book_sessions
            .iter()
            .filter(|session| session["browsing"] != true)
        {
            overall_sessions += 1;
            overall_pages += session_pages(session);
        }
    }

    let type_names: HashMap<_, _> = array(&state["types"])
        .iter()
        .map(|category_type| (text(category_type, "id"), text(category_type, "name")))
        .collect();
    let categories: Vec<_> = array(&state["categories"])
        .iter()
        .map(|category| {
            let members = array(&category["members"])
                .iter()
                .filter(|member| books_by_id.contains_key(text(member, "bookId")))
                .collect::<Vec<_>>();
            let ratings = members
                .iter()
                .filter_map(|member| books_by_id[text(member, "bookId")]["rating"].as_f64())
                .collect::<Vec<_>>();
            let computed_rating =
                (!ratings.is_empty()).then(|| ratings.iter().sum::<f64>() / ratings.len() as f64);
            let rating_override = category["ratingOverride"]
                .as_f64()
                .or_else(|| category["rating"].as_f64());
            json!({
                "id": category["id"],
                "name": category["name"],
                "description": category["description"].as_str().unwrap_or_default(),
                "types": array(&category["typeIds"]).iter()
                    .filter_map(|id| type_names.get(str_value(id))).collect::<Vec<_>>(),
                "members": members.iter().map(|member| json!({
                    "bookId": member["bookId"],
                    "position": member["position"],
                })).collect::<Vec<_>>(),
                "rating": rating_override.or(computed_rating),
                "ratingOverride": rating_override,
            })
        })
        .collect();
    let exported_authors: Vec<_> = authors
        .into_iter()
        .map(|(author, book_ids)| {
            let active_seconds: u64 = book_ids
                .iter()
                .map(|id| credited_time(sessions.get(id).map(Vec::as_slice).unwrap_or_default()))
                .sum();
            json!({
                "name": author,
                "bookIds": book_ids,
                "totalActiveSeconds": active_seconds,
            })
        })
        .collect();

    let profile = json!({
        "schemaVersion": 1,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "exportedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "books": books,
        "authors": exported_authors,
        "categories": categories,
        "stats": {
            "books": books.len(),
            "finishedReadThroughs": finished_read_throughs,
            "activeSeconds": overall_seconds,
            "sessions": overall_sessions,
            "pagesRead": overall_pages,
        },
    });
    let mut bytes = serde_json::to_vec_pretty(&profile)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn escape_markdown(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for ch in value.chars().filter(|ch| !ch.is_control() || *ch == '\n') {
        if matches!(
            ch,
            '\\' | '`'
                | '*'
                | '_'
                | '{'
                | '}'
                | '['
                | ']'
                | '('
                | ')'
                | '#'
                | '+'
                | '-'
                | '.'
                | '!'
                | '|'
                | '>'
                | '<'
                | '~'
        ) {
            output.push('\\');
        }
        output.push(ch);
    }
    output
}

pub fn notes(state: &Value, book_id: &str) -> Result<Vec<u8>> {
    let book = array(&state["books"])
        .iter()
        .find(|book| text(book, "id") == book_id && !is_ignored(book))
        .context("Book is unavailable")?;
    let mut result = format!(
        "# {}\n",
        escape_markdown(&text(book, "title").replace('\n', " "))
    );
    let mut entries: Vec<_> = array(&state["annotations"])
        .iter()
        .filter(|note| text(note, "bookId") == book_id)
        .collect();
    entries.sort_by_key(|note| note["createdAt"].as_i64());
    if entries.is_empty() {
        result.push_str("\nNo notes or bookmarks.\n");
    }
    for entry in entries {
        let kind = match text(entry, "kind") {
            "bookmark" => "Bookmark",
            "page" => "Page note",
            _ => "Highlight",
        };
        let locator = &entry["locator"];
        let location = locator["page"]
            .as_u64()
            .map(|page| format!(" · page {}", page + 1))
            .or_else(|| {
                locator["chapter"]
                    .as_u64()
                    .map(|chapter| format!(" · chapter {}", chapter + 1))
            })
            .unwrap_or_default();
        let date = timestamp(&entry["createdAt"])
            .map(|time| time.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        result.push_str(&format!("\n## {kind}{location}\n\n"));
        if !date.is_empty() {
            result.push_str(&format!("{date}\n\n"));
        }
        for line in text(entry, "text").lines() {
            result.push_str(&format!("> {}\n", escape_markdown(line)));
        }
        let annotation = text(entry, "note");
        if !annotation.is_empty() {
            result.push_str(&format!("\n{}\n", escape_markdown(annotation)));
        }
    }
    Ok(result.into_bytes())
}

fn sqlite_version(bytes: &[u8]) -> Result<u64> {
    ensure!(
        bytes.len() >= 100 && bytes.starts_with(SQLITE_MAGIC),
        "Backup does not contain a valid SQLite database"
    );
    Ok(u32::from_be_bytes(bytes[60..64].try_into()?) as u64)
}

pub fn backup(state: &Value, db_file_bytes: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        db_file_bytes.len() as u64 <= MAX_DB_BYTES,
        "Database is too large to archive"
    );
    let version = sqlite_version(db_file_bytes)?;
    let folders: Vec<_> = array(&state["folders"])
        .iter()
        .filter_map(|folder| {
            folder
                .as_str()
                .or_else(|| folder["displayPath"].as_str())
                .or_else(|| folder["path"].as_str())
        })
        .collect();
    let manifest = json!({
        "schemaVersion": BACKUP_SCHEMA_VERSION,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "databaseVersion": version,
        "createdAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "folders": folders,
    });
    let manifest = serde_json::to_vec_pretty(&manifest)?;
    ensure!(
        manifest.len() as u64 <= MAX_MANIFEST_BYTES,
        "Backup manifest is too large"
    );
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer.start_file("manifest.json", options)?;
    writer.write_all(&manifest)?;
    writer.start_file("library.sqlite3", options)?;
    writer.write_all(db_file_bytes)?;
    Ok(writer.finish()?.into_inner())
}

fn read_zip_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>> {
    let entry = archive
        .by_name(name)
        .with_context(|| format!("Backup is missing {name}"))?;
    ensure!(
        entry.is_file() && entry.size() <= limit,
        "Invalid size for {name}"
    );
    let expected_size = entry.size();
    let mut bytes = Vec::new();
    entry.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == expected_size,
        "Invalid data for {name}"
    );
    Ok(bytes)
}

pub fn restore(bytes: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        bytes.len() as u64 <= MAX_DB_BYTES + MAX_MANIFEST_BYTES + 1024 * 1024,
        "Backup exceeds the size limit"
    );
    let mut archive = ZipArchive::new(Cursor::new(bytes)).context("Invalid Deft backup archive")?;
    ensure!(archive.len() == 2, "Unexpected files in Deft backup");
    let manifest = read_zip_entry(&mut archive, "manifest.json", MAX_MANIFEST_BYTES)?;
    let manifest: Value = serde_json::from_slice(&manifest).context("Invalid backup manifest")?;
    ensure!(
        manifest["schemaVersion"].as_u64() == Some(BACKUP_SCHEMA_VERSION),
        "Unsupported Deft backup version"
    );
    let db = read_zip_entry(&mut archive, "library.sqlite3", MAX_DB_BYTES)?;
    ensure!(
        manifest["databaseVersion"].as_u64() == Some(sqlite_version(&db)?),
        "The backup manifest and database versions differ"
    );
    Ok(db)
}

fn weekly_date(filename: &str) -> Option<NaiveDate> {
    let date = filename.strip_prefix(WEEKLY_PREFIX)?.strip_suffix(".zip")?;
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    (parsed.format("%Y-%m-%d").to_string() == date).then_some(parsed)
}

pub fn rotate_weekly(folder: &Path, retention: usize, archive: &[u8]) -> Result<PathBuf> {
    ensure!(
        folder.is_dir(),
        "The automatic backup folder is unavailable"
    );
    let date = Local::now().format("%Y-%m-%d").to_string();
    let path = folder.join(format!("{WEEKLY_PREFIX}{date}.zip"));
    if !path.exists() {
        let mut file = tempfile::Builder::new()
            .prefix(".deft-weekly-")
            .tempfile_in(folder)?;
        file.write_all(archive)?;
        file.as_file().sync_all()?;
        match file.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.error).context("Could not save the weekly backup"),
        }
    }
    ensure!(
        is_deft_backup(&path),
        "An existing file conflicts with the automatic backup"
    );

    let mut files = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if let Some(date) = entry.file_name().to_str().and_then(weekly_date) {
            if is_deft_backup(&entry.path()) {
                files.push((date, entry.path()));
            }
        }
    }
    files.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let keep_other = retention.max(1) - 1;
    for (_, old) in files
        .into_iter()
        .filter(|(_, old)| old != &path)
        .skip(keep_other)
    {
        fs::remove_file(&old).with_context(|| format!("Could not delete {}", old.display()))?;
    }
    Ok(path)
}

fn is_deft_backup(path: &Path) -> bool {
    let check = || -> Result<()> {
        ensure!(fs::symlink_metadata(path)?.file_type().is_file());
        let file = File::open(path)?;
        ensure!(file.metadata()?.len() <= MAX_DB_BYTES + MAX_MANIFEST_BYTES + 1024 * 1024);
        let mut archive = ZipArchive::new(file)?;
        ensure!(archive.len() == 2);
        let manifest = read_zip_entry(&mut archive, "manifest.json", MAX_MANIFEST_BYTES)?;
        let manifest: Value = serde_json::from_slice(&manifest)?;
        ensure!(manifest["schemaVersion"].as_u64() == Some(BACKUP_SCHEMA_VERSION));
        let mut header = [0; 100];
        archive
            .by_name("library.sqlite3")?
            .read_exact(&mut header)?;
        ensure!(manifest["databaseVersion"].as_u64() == Some(sqlite_version(&header)?));
        Ok(())
    };
    check().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Value {
        json!({
            "books": [
                {"id": "one", "title": "A, Book", "authors": ["Ada Author", "Co Author"], "format": "epub",
                    "edition": {"provider": "openlibrary", "isbn10": "0451524934", "goodreadsId": 42,
                        "title": "A, Book", "authors": ["Ada Author"], "coverUrl": "https://example.org/secret"},
                    "rating": 3.5, "favorite": true, "review": "=private review",
                    "addedAt": 1704067200000_i64, "files": [{"path": "C:/local/book.epub"}]},
                {"id": "two", "title": "Unmatched", "authors": ["Ada Author"], "format": "txt"},
                {"id": "hidden", "title": "Ignored", "authors": ["Skip Me"], "format": "pdf", "ignored": true}
            ],
            "categories": [
                {"id": "category", "name": "Reading Club", "typeIds": ["club"],
                    "members": [{"bookId": "one", "position": 2.5}, {"bookId": "hidden", "position": 3}]}
            ],
            "types": [{"id": "club", "name": "Book club"}],
            "readThroughs": [
                {"id": "first", "bookId": "one", "startedAt": 1704067200000_i64,
                    "endedAt": 1704153600000_i64, "outcome": "finished", "zoneOffsetMinutes": -300},
                {"id": "current", "bookId": "one", "startedAt": 1704240000000_i64,
                    "outcome": "abandoned", "endedAt": 1704326400000_i64}
            ],
            "annotations": [
                {"bookId": "one", "kind": "highlight", "text": "Passage", "note": "Private note",
                    "locator": {"chapter": 1}, "createdAt": 1704067200000_i64, "updatedAt": 1704067200000_i64}
            ],
            "sessions": [
                {"bookId": "one", "activeSeconds": 120, "startLocator":{"position":4}, "endLocator":{"position":8}},
                {"bookId": "one", "activeSeconds": 960, "browsing": true},
                {"bookId": "hidden", "activeSeconds": 480}
            ],
            "folders":[{"path":"C:/private"}],
            "settings":{"hardcoverToken":"my-secret"},
        })
    }

    #[test]
    fn goodreads_preserves_the_expected_header_mapping_and_privacy() {
        let state = state();
        let bytes = goodreads(&state, &Value::Null).unwrap();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap().replace("\r\n", "\n"),
            include_str!("../testdata/goodreads-export.csv").replace("\r\n", "\n")
        );
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        assert_eq!(
            reader.headers().unwrap().iter().collect::<Vec<_>>(),
            GOODREADS_COLUMNS
        );
        let records: Vec<_> = reader.records().map(Result::unwrap).collect();
        assert_eq!(records.len(), 1);
        let row = &records[0];
        assert_eq!(&row[0], "42");
        assert_eq!(&row[1], "A, Book");
        assert_eq!(&row[3], "Author, Ada");
        assert_eq!(&row[5], "=\"0451524934\"");
        assert_eq!(&row[7], "4");
        assert_eq!(&row[14], "2024/01/01");
        assert_eq!(&row[16], "reading-club");
        assert_eq!(&row[17], "reading-club (#2.5)");
        assert_eq!(&row[18], "did-not-finish");
        assert_eq!(&row[19], "");
        assert_eq!(&row[22], "1");
        assert_eq!(unmatched_count(&state), 1);

        let bytes = goodreads(
            &state,
            &json!({"matchedOnly": false, "includeReviews": true}),
        )
        .unwrap();
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        let records: Vec<_> = reader.records().map(Result::unwrap).collect();
        assert_eq!(records.len(), 2);
        assert_eq!(&records[0][19], "'=private review");
        assert_eq!(&records[1][18], "to-read");
    }

    #[test]
    fn profile_excludes_paths_notes_reviews_and_browsing_by_default() {
        let data = profile(&state(), &Value::Null).unwrap();
        let text = std::str::from_utf8(&data).unwrap();
        for secret in [
            "C:/",
            "Private note",
            "private review",
            "my-secret",
            "coverUrl",
            "locator",
            "Skip Me",
        ] {
            assert!(!text.contains(secret), "private field leaked: {secret}");
        }
        let value: Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["books"][0]["rating"], 3.5);
        assert_eq!(value["books"][0]["totalActiveSeconds"], 120);
        assert_eq!(value["stats"]["pagesRead"], 4);
        assert_eq!(value["stats"]["sessions"], 1);
        assert_eq!(
            value["categories"][0]["members"].as_array().unwrap().len(),
            1
        );

        let data = profile(
            &state(),
            &json!({"includeNotes": true, "includeReviews": true}),
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(value["books"][0]["notes"][0]["note"], "Private note");
        assert_eq!(value["books"][0]["review"], "=private review");
    }

    #[test]
    fn backup_round_trip_uses_only_manifest_and_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("valid.sqlite3");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE books (id TEXT); PRAGMA user_version = 1;")
            .unwrap();
        drop(connection);
        let database = fs::read(&path).unwrap();
        let bytes = backup(&state(), &database).unwrap();
        assert_eq!(restore(&bytes).unwrap(), database);
        assert!(restore(b"this is not a zip").is_err());
        let mut archive = ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let manifest: Value = serde_json::from_slice(
            &read_zip_entry(&mut archive, "manifest.json", MAX_MANIFEST_BYTES).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["databaseVersion"], 1);
        assert_eq!(manifest["folders"][0], "C:/private");
        assert!(manifest.get("hardcoverToken").is_none());
        assert_eq!(archive.len(), 2);

        let manual = directory.path().join("deft-backup-2000-01-01.zip");
        fs::write(&manual, &bytes).unwrap();
        let unrelated = directory.path().join("deft-weekly-2000-01-01.zip");
        fs::write(&unrelated, b"keep this unrelated file").unwrap();
        let old = directory.path().join("deft-weekly-2000-01-02.zip");
        fs::write(&old, &bytes).unwrap();
        let latest = rotate_weekly(directory.path(), 1, &bytes).unwrap();
        assert_eq!(fs::read(latest).unwrap(), bytes);
        assert!(!old.exists());
        assert!(manual.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn restores_a_complete_deft_library_from_its_snapshot() -> Result<()> {
        use crate::model::{Book, Folder, Overrides, State};
        use crate::store::Store;

        let directory = tempfile::tempdir()?;
        let path = directory.path().join("library.sqlite3");
        let mut store = Store::open(&path)?;
        let mut state: State = serde_json::from_value(state())?;
        state.folders.push(Folder {
            id: "extra-source".into(),
            path: "D:/library".into(),
            ..Folder::default()
        });
        state.books.push(Book {
            id: "custom-cover".into(),
            overrides: Overrides {
                cover: Some("data:image/png;base64,example".into()),
                ..Overrides::default()
            },
            ..Book::default()
        });
        state.settings["importedFonts"] =
            json!([{"name":"Library font", "data":"data:font/ttf;base64,example"}]);
        store.save(&state)?;

        let archive = backup(
            &serde_json::to_value(&state)?,
            &store.backup(directory.path())?,
        )?;
        drop(store);
        fs::remove_file(path)?;
        let restored = Store::decode_backup(directory.path(), &restore(&archive)?)?;

        assert_eq!(restored.books.len(), state.books.len());
        assert_eq!(restored.folders[1].path, "D:/library");
        assert_eq!(restored.read_throughs.len(), 2);
        assert_eq!(restored.sessions[0].active_seconds, 120);
        assert_eq!(restored.annotations[0].note, "Private note");
        assert_eq!(
            restored.settings["importedFonts"],
            state.settings["importedFonts"]
        );
        assert_eq!(
            restored.books[3].overrides.cover,
            state.books[3].overrides.cover
        );
        Ok(())
    }
}
