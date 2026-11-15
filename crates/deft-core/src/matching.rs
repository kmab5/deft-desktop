// SPDX-License-Identifier: GPL-3.0-only
//! Explicit edition and cover requests. The rest of the application stays offline.

use std::collections::HashSet;
use std::io::Read;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use reqwest::Url;
use serde_json::{json, Value};

const OPEN_LIBRARY: &str = "https://openlibrary.org";
const GOOGLE_BOOKS: &str = "https://www.googleapis.com/books/v1/volumes";
const HARDCOVER: &str = "https://api.hardcover.app/v1/graphql";
const MAX_JSON_SIZE: u64 = 2 * 1024 * 1024;
const MAX_COVER_SIZE: u64 = 4 * 1024 * 1024;
const LIMIT: usize = 8;
static LAST_OPEN_LIBRARY_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn str_value(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn string_list(value: &Value) -> Vec<&str> {
    array(value).iter().filter_map(Value::as_str).collect()
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .user_agent(concat!(
            "DeftDesktop/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/kmab5/deft)"
        ))
        .build()?)
}

fn limited_body(response: Response, limit: u64) -> Result<Vec<u8>> {
    let response = response.error_for_status()?;
    ensure!(
        response.content_length().unwrap_or_default() <= limit,
        "Provider response exceeds the size limit"
    );
    let mut body = Vec::new();
    response.take(limit + 1).read_to_end(&mut body)?;
    ensure!(
        body.len() as u64 <= limit,
        "Provider response exceeds the size limit"
    );
    Ok(body)
}

fn response_json(response: Response) -> Result<Value> {
    Ok(serde_json::from_slice(&limited_body(
        response,
        MAX_JSON_SIZE,
    )?)?)
}

fn bool_setting(settings: &Value, flat: &str, nested: &str, default: bool) -> bool {
    settings[flat]
        .as_bool()
        .or_else(|| settings["matching"][nested].as_bool())
        .unwrap_or(default)
}

fn normalize_isbn(raw: &str) -> Option<String> {
    let mut isbn = String::new();
    for character in raw.chars() {
        match character {
            '0'..='9' => isbn.push(character),
            'x' | 'X' => isbn.push('X'),
            '-' | ' ' | '\t' => {}
            _ => return None,
        }
    }
    let valid = match isbn.len() {
        10 => isbn
            .bytes()
            .enumerate()
            .try_fold(0u32, |sum, (index, byte)| {
                let digit = match byte {
                    b'0'..=b'9' => (byte - b'0') as u32,
                    b'X' if index == 9 => 10,
                    _ => return None,
                };
                Some(sum + (10 - index as u32) * digit)
            })
            .is_some_and(|sum| sum % 11 == 0),
        13 if isbn.starts_with("978") || isbn.starts_with("979") => isbn
            .bytes()
            .enumerate()
            .try_fold(0u32, |sum, (index, byte)| {
                if !byte.is_ascii_digit() {
                    return None;
                }
                let weight = if index % 2 == 0 { 1 } else { 3 };
                Some(sum + (byte - b'0') as u32 * weight)
            })
            .is_some_and(|sum| sum % 10 == 0),
        _ => false,
    };
    valid.then_some(isbn)
}

fn equivalent_isbn(isbn: &str) -> Option<String> {
    match isbn.len() {
        10 => {
            let mut prefix = format!("978{}", isbn.get(..9)?);
            let sum: u32 = prefix
                .bytes()
                .enumerate()
                .map(|(index, d)| {
                    let weight = if index % 2 == 0 { 1 } else { 3 };
                    (d - b'0') as u32 * weight
                })
                .sum();
            prefix.push(char::from_digit((10 - sum % 10) % 10, 10)?);
            Some(prefix)
        }
        13 if isbn.starts_with("978") => {
            let prefix = isbn.get(3..12)?;
            let sum: u32 = prefix
                .bytes()
                .enumerate()
                .map(|(index, d)| (10 - index as u32) * (d - b'0') as u32)
                .sum();
            let check = (11 - sum % 11) % 11;
            let check = if check == 10 {
                'X'
            } else {
                char::from_digit(check, 10)?
            };
            Some(format!("{prefix}{check}"))
        }
        _ => None,
    }
}

fn publication_year(date: &str) -> Option<u16> {
    date.as_bytes().windows(4).find_map(|digits| {
        let year: u16 = std::str::from_utf8(digits).ok()?.parse().ok()?;
        (year >= 1000).then_some(year)
    })
}

fn provider_title(raw: &str) -> &str {
    let raw = raw.trim();
    raw.char_indices()
        .nth(240)
        .map(|(i, _)| &raw[..i])
        .unwrap_or(raw)
}

fn safe_cover_url(url: &str) -> Option<Url> {
    let parsed = Url::parse(url).ok()?;
    let allowed_host = matches!(
        parsed.host_str()?,
        "covers.openlibrary.org"
            | "books.google.com"
            | "books.googleusercontent.com"
            | "images.hardcover.app"
            | "assets.hardcover.app"
            | "cdn.hardcover.app"
    );
    (parsed.scheme() == "https"
        && allowed_host
        && parsed.port().is_none()
        && parsed.username().is_empty()
        && parsed.password().is_none())
    .then_some(parsed)
}

fn provider_cover_url(url: &str) -> Option<String> {
    let https = url
        .strip_prefix("http://")
        .map(|rest| format!("https://{rest}"));
    safe_cover_url(https.as_deref().unwrap_or(url)).map(|u| u.to_string())
}

fn with_isbns(mut value: Value, isbn_candidates: Vec<&str>, requested: &[String]) -> Value {
    let codes: Vec<_> = isbn_candidates
        .into_iter()
        .filter_map(normalize_isbn)
        .collect();
    let unique_exact = requested.iter().find_map(|isbn| {
        let equivalent = equivalent_isbn(isbn);
        codes
            .iter()
            .find(|code| *code == isbn || Some(*code) == equivalent.as_ref())
    });
    let title = str_value(&value["title"]);
    if title.is_empty() {
        return Value::Null;
    }
    value["exactIsbn"] = json!(unique_exact.is_some());
    // Derive the same edition's paired barcode instead of cross-wiring two
    // different editions returned in an aggregate result.
    if let Some(isbn) = unique_exact.or_else(|| codes.first()) {
        let equivalent = equivalent_isbn(isbn);
        if isbn.len() == 10 {
            value["isbn10"] = json!(isbn);
            value["isbn13"] = json!(equivalent);
        } else {
            value["isbn10"] = json!(equivalent);
            value["isbn13"] = json!(isbn);
        }
    }
    value
}

fn id_from_path<'a>(value: &'a str, prefix: &str, suffix: char) -> Option<&'a str> {
    let id = value
        .split(prefix)
        .nth(1)
        .unwrap_or(value)
        .split('/')
        .next()?;
    let number = id.strip_prefix("OL")?.strip_suffix(suffix)?;
    (!number.is_empty() && number.chars().all(|c| c.is_ascii_digit())).then_some(id)
}

fn json_first(value: &Value) -> &Value {
    array(value).first().unwrap_or(&Value::Null)
}

fn call_open_library(client: &Client, path: &str, query: &[(&str, &str)]) -> Result<Value> {
    // Open Library limits anonymous callers to one request per second. The
    // same limiter covers parallel, explicit bulk matching operations.
    let mut previous = LAST_OPEN_LIBRARY_REQUEST
        .lock()
        .map_err(|_| anyhow::anyhow!("Open Library rate limiter is unavailable"))?;
    if let Some(last) = *previous {
        thread::sleep(Duration::from_secs(1).saturating_sub(last.elapsed()));
    }
    *previous = Some(Instant::now());
    drop(previous);
    response_json(
        client
            .get(format!("{OPEN_LIBRARY}{path}"))
            .query(query)
            .send()?,
    )
}

fn open_library_exact(client: &Client, isbns: &[String]) -> Result<Vec<Value>> {
    let mut keys = Vec::new();
    for isbn in isbns {
        for code in std::iter::once(isbn.clone()).chain(equivalent_isbn(isbn)) {
            let key = format!("ISBN:{code}");
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    let result = call_open_library(
        client,
        "/api/books",
        &[
            ("bibkeys", &keys.join(",")),
            ("jscmd", "data"),
            ("format", "json"),
        ],
    )?;
    let mut candidates = Vec::new();
    let mut ids = HashSet::new();
    for key in keys {
        let info = &result[&key];
        let edition_id = id_from_path(str_value(&info["url"]), "/books/", 'M');
        if !info.is_object() || edition_id.is_some_and(|id| !ids.insert(id.to_owned())) {
            continue;
        }
        let authors: Vec<_> = array(&info["authors"])
            .iter()
            .filter_map(|author| author["name"].as_str())
            .collect();
        let identifiers = &info["identifiers"];
        let mut codes = string_list(&identifiers["isbn_13"]);
        codes.extend(string_list(&identifiers["isbn_10"]));
        // The exact endpoint is keyed by ISBN, even when the response omits
        // a redundant identifiers field for that edition.
        if codes.is_empty() {
            codes.push(key.strip_prefix("ISBN:").unwrap_or_default());
        }
        let cover = provider_cover_url(str_value(&info["cover"]["large"]))
            .or_else(|| provider_cover_url(str_value(&info["cover"]["medium"])));
        let numeric_goodreads_id = json_first(&identifiers["goodreads"])
            .as_str()
            .and_then(|value| value.parse::<u64>().ok());
        let candidate = with_isbns(
            json!({
                "provider": "openlibrary",
                "title": info["title"],
                "authors": authors,
                "editionId": edition_id,
                "goodreadsId": numeric_goodreads_id,
                "googleBooksId": json_first(&identifiers["google"]),
                "year": publication_year(str_value(&info["publish_date"])),
                "publisher": json_first(&info["publishers"])["name"],
                "pages": info["number_of_pages"],
                "coverUrl": cover,
            }),
            codes,
            isbns,
        );
        if candidate.is_object() {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

fn open_library(
    client: &Client,
    title: &str,
    author: &str,
    isbns: &[String],
) -> Result<Vec<Value>> {
    if !isbns.is_empty() {
        return open_library_exact(client, isbns);
    }
    let result = call_open_library(client, "/search.json", &[
        ("title", title), ("author", author), ("limit", "8"),
        ("fields", "key,title,author_name,cover_i,number_of_pages_median,first_publish_year,editions,editions.key,editions.title,editions.isbn,editions.cover_i"),
    ])?;
    Ok(array(&result["docs"])
        .iter()
        .take(LIMIT)
        .filter_map(|work| {
            let edition = json_first(&work["editions"]["docs"]);
            let year = work["first_publish_year"].as_u64();
            let cover = edition["cover_i"]
                .as_u64()
                .or_else(|| work["cover_i"].as_u64())
                .map(|id| format!("https://covers.openlibrary.org/b/id/{id}-L.jpg?default=false"));
            let candidate = with_isbns(
                json!({
                    "provider": "openlibrary",
                    "title": edition["title"].as_str().unwrap_or_else(|| str_value(&work["title"])),
                    "authors": string_list(&work["author_name"]),
                    "workId": id_from_path(str_value(&work["key"]), "/works/", 'W'),
                    "editionId": id_from_path(str_value(&edition["key"]), "/books/", 'M'),
                    "coverUrl": cover,
                    "year": year,
                    "pages": work["number_of_pages_median"],
                }),
                string_list(&edition["isbn"]),
                isbns,
            );
            candidate.is_object().then_some(candidate)
        })
        .collect())
}

fn query_term(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, '\"' | '\\') && !c.is_control())
        .collect()
}

fn google_books(
    client: &Client,
    title: &str,
    author: &str,
    isbns: &[String],
) -> Result<Vec<Value>> {
    let query = if let Some(isbn) = isbns.first() {
        format!("isbn:{isbn}")
    } else if author.is_empty() {
        format!("intitle:\"{}\"", query_term(title))
    } else {
        format!(
            "intitle:\"{}\" inauthor:\"{}\"",
            query_term(title),
            query_term(author)
        )
    };
    let result = response_json(
        client
            .get(GOOGLE_BOOKS)
            .query(&[
                ("q", query.as_str()),
                ("printType", "books"),
                ("maxResults", "8"),
            ])
            .send()?,
    )?;
    Ok(array(&result["items"])
        .iter()
        .take(LIMIT)
        .filter_map(|volume| {
            let info = &volume["volumeInfo"];
            let isbns_found = array(&info["industryIdentifiers"])
                .iter()
                .filter_map(|identifier| {
                    matches!(str_value(&identifier["type"]), "ISBN_10" | "ISBN_13")
                        .then(|| identifier["identifier"].as_str())
                        .flatten()
                })
                .collect();
            let cover = provider_cover_url(str_value(&info["imageLinks"]["thumbnail"]))
                .or_else(|| provider_cover_url(str_value(&info["imageLinks"]["smallThumbnail"])));
            let candidate = with_isbns(
                json!({
                    "provider": "googlebooks",
                    "title": info["title"],
                    "authors": string_list(&info["authors"]),
                    "googleBooksId": volume["id"],
                    "year": publication_year(str_value(&info["publishedDate"])),
                    "publisher": info["publisher"],
                    "pages": info["pageCount"],
                    "coverUrl": cover,
                }),
                isbns_found,
                isbns,
            );
            candidate.is_object().then_some(candidate)
        })
        .collect())
}

fn hardcover_query(client: &Client, token: &str, query: &str, variables: Value) -> Result<Value> {
    let response = client
        .post(HARDCOVER)
        .bearer_auth(token)
        .json(&json!({"query": query, "variables": variables}))
        .send()?;
    let body = response_json(response)?;
    ensure!(
        array(&body["errors"]).is_empty(),
        "Hardcover rejected the request"
    );
    Ok(body["data"].clone())
}

fn hardcover_candidate(book: &Value, edition: &Value, isbns: &[String]) -> Value {
    let authors: Vec<_> = array(&book["contributions"])
        .iter()
        .filter_map(|contribution| contribution["author"]["name"].as_str())
        .collect();
    let cover = provider_cover_url(str_value(&book["image"]["url"]));
    let ids = [edition["isbn_13"].as_str(), edition["isbn_10"].as_str()]
        .into_iter()
        .flatten()
        .collect();
    with_isbns(
        json!({
            "provider": "hardcover",
            "title": book["title"],
            "authors": authors,
            "hardcoverId": book["id"].as_u64().map(|id| id.to_string()),
            "year": publication_year(str_value(&edition["release_date"]))
                .or_else(|| publication_year(str_value(&book["release_date"]))),
            "pages": edition["pages"].as_u64().or_else(|| book["pages"].as_u64()),
            "coverUrl": cover,
        }),
        ids,
        isbns,
    )
}

fn hardcover(
    client: &Client,
    title: &str,
    author: &str,
    isbns: &[String],
    token: &str,
) -> Result<Vec<Value>> {
    if let Some(isbn) = isbns.first() {
        let keys = vec![
            isbn.to_owned(),
            equivalent_isbn(isbn).unwrap_or_else(|| isbn.to_owned()),
        ];
        let data = hardcover_query(
            client,
            token,
            r#"
            query EditionByIsbn($isbns: [String!]!) {
              editions(where: {_or: [{isbn_13: {_in: $isbns}}, {isbn_10: {_in: $isbns}}]}, limit: 8) {
                isbn_10 isbn_13 release_date pages
                book { id title release_date pages image { url } contributions { author { name } } }
              }
            }
        "#,
            json!({"isbns": keys}),
        )?;
        return Ok(array(&data["editions"])
            .iter()
            .map(|edition| hardcover_candidate(&edition["book"], edition, isbns))
            .filter(Value::is_object)
            .collect());
    }
    let data = hardcover_query(
        client,
        token,
        r#"
        query SearchBooks($query: String!) {
          search(query: $query, query_type: "book", per_page: 8) { ids }
        }
    "#,
        json!({"query": format!("{title} {author}").trim()}),
    )?;
    let ids: Vec<_> = array(&data["search"]["ids"])
        .iter()
        .filter_map(Value::as_i64)
        .take(LIMIT)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let data = hardcover_query(
        client,
        token,
        r#"
        query SearchBookDetails($ids: [Int!]!) {
          books(where: {id: {_in: $ids}}) {
            id title release_date pages image { url } contributions { author { name } }
          }
        }
    "#,
        json!({"ids": ids}),
    )?;
    Ok(ids
        .iter()
        .filter_map(|id| {
            let book = array(&data["books"])
                .iter()
                .find(|book| book["id"].as_i64() == Some(*id))?;
            let candidate = hardcover_candidate(book, &Value::Null, isbns);
            candidate.is_object().then_some(candidate)
        })
        .collect())
}

pub fn candidates(book: &Value, settings: &Value) -> Result<Vec<Value>> {
    let client = client()?;
    let title = provider_title(str_value(&book["title"]));
    let author = provider_title(str_value(json_first(&book["authors"])));
    let mut isbns: Vec<_> = ["isbn13", "isbn10"]
        .iter()
        .filter_map(|name| normalize_isbn(str_value(&book["metadata"][name])))
        .collect();
    isbns.dedup();
    ensure!(
        !title.is_empty() || !isbns.is_empty(),
        "This book has no title or ISBN to look up"
    );

    let token = settings["hardcoverToken"]
        .as_str()
        .or_else(|| settings["matching"]["hardcoverToken"].as_str())
        .unwrap_or_default()
        .trim();
    let open_library_enabled = bool_setting(settings, "matchingOpenLibrary", "openLibrary", true);
    let google_books_enabled = bool_setting(settings, "matchingGoogleBooks", "googleBooks", true);
    let hardcover_enabled =
        bool_setting(settings, "matchingHardcover", "hardcover", false) && !token.is_empty();
    ensure!(
        open_library_enabled || google_books_enabled || hardcover_enabled,
        "Enable an edition provider in settings"
    );

    let mut errors = Vec::new();
    let mut candidates = Vec::new();
    let mut successful = false;
    for (enabled, provider) in [
        (open_library_enabled, 0),
        (google_books_enabled, 1),
        (hardcover_enabled, 2),
    ] {
        if !enabled {
            continue;
        }
        let label = ["Open Library", "Google Books", "Hardcover"][provider];
        let result = match provider {
            0 => open_library(&client, title, author, &isbns),
            1 => google_books(&client, title, author, &isbns),
            _ => hardcover(&client, title, author, &isbns, token),
        };
        match result {
            Ok(results) => {
                successful = true;
                let sufficient = results
                    .iter()
                    .any(|candidate| candidate["exactIsbn"] == true)
                    || (isbns.is_empty() && !results.is_empty());
                candidates.extend(results);
                if sufficient {
                    break;
                }
            }
            Err(error) => {
                // Report provider failures without exposing URL query strings or
                // authentication details in the visible error.
                let status = error
                    .downcast_ref::<reqwest::Error>()
                    .and_then(reqwest::Error::status)
                    .map(|status| format!(" ({})", status.as_u16()))
                    .unwrap_or_default();
                errors.push(format!("{label}{status}"));
            }
        }
    }
    if !successful {
        bail!(
            "Edition lookup failed for {}. Check the connection or provider settings.",
            errors.join(", ")
        );
    }
    candidates.sort_by_key(|candidate| candidate["exactIsbn"] != true);
    Ok(candidates)
}

fn cover_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

pub fn cover(url: &str) -> Result<String> {
    let client = client()?;
    let mut url =
        safe_cover_url(url).context("Cover URLs must use a supported HTTPS image host")?;
    for _ in 0..4 {
        let response = client.get(url.clone()).send()?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .context("Cover server redirected without a location")?
                .to_str()?;
            let next = url.join(next)?;
            url = safe_cover_url(next.as_str())
                .context("Cover server redirected outside supported hosts")?;
            continue;
        }
        let bytes = limited_body(response, MAX_COVER_SIZE)?;
        ensure!(
            cover_mime(&bytes).is_some(),
            "The provider did not return a supported image"
        );
        return crate::formats::cover_image(&bytes)
            .context("Could not decode the provider's cover image");
    }
    bail!("Too many cover redirects")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_client_is_confined_to_matching() {
        fn check(path: &std::path::Path) {
            for entry in std::fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if path.is_dir() {
                    check(&path);
                } else if path.extension().is_some_and(|suffix| suffix == "rs")
                    && path
                        .file_name()
                        .is_some_and(|filename| filename != "matching.rs")
                {
                    let source = std::fs::read_to_string(&path).unwrap();
                    for http_dependency in ["reqwest::", "ureq::", "hyper::", "TcpStream::"] {
                        assert!(
                            !source.contains(http_dependency),
                            "unexpected direct network access in {}",
                            path.display()
                        );
                    }
                }
            }
        }
        let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        check(&core.join("src"));
        check(&core.join("../../src-tauri/src"));
    }

    #[test]
    fn exact_match_keeps_identifiers_for_one_edition() {
        let requested = vec!["0451524934".to_owned()];
        let candidate = with_isbns(
            json!({"title": "1984"}),
            vec!["9780151010264", "978-0-451-52493-5"],
            &requested,
        );
        assert_eq!(candidate["exactIsbn"], true);
        assert_eq!(candidate["isbn10"], "0451524934");
        assert_eq!(candidate["isbn13"], "9780451524935");
        assert!(normalize_isbn("9780451524936").is_none());
    }

    #[test]
    fn covers_accept_only_provider_https_raster_urls() {
        assert!(safe_cover_url("https://covers.openlibrary.org/b/id/123.jpg").is_some());
        assert!(safe_cover_url("https://covers.openlibrary.org.evil.invalid/").is_none());
        assert!(safe_cover_url("https://covers.openlibrary.org@127.0.0.1/").is_none());
        assert!(safe_cover_url("https://covers.openlibrary.org:8443/").is_none());
        assert!(safe_cover_url("http://covers.openlibrary.org/b/id/123.jpg").is_none());
        assert_eq!(cover_mime(b"<svg/>"), None);
    }
}
