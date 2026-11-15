// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    desktop::{cache_bytes, keep_awake, Desktop},
    publication,
};
use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use deft_core::{
    catalog, exchange, id, matching,
    model::{Annotation, BookState, Folder, State, FORMATS},
    now, scanner, tracking,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|error| anyhow!("Invalid input: {error}"))
}
fn result(value: impl Serialize) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("Missing {key}."))
}
fn optional_text<'a>(args: &'a Value, key: &str) -> &'a str {
    args[key].as_str().unwrap_or_default()
}
fn string_list(args: &Value, key: &str) -> Result<Vec<String>> {
    if args[key].is_null() {
        return Ok(vec![]);
    }
    decode(&args[key])
}
fn selected(path: Option<FilePath>) -> Result<Option<PathBuf>> {
    path.map(|entry| {
        entry
            .into_path()
            .map_err(|error| anyhow!("Select a local file: {error}"))
    })
    .transpose()
}

pub fn run(window: &WebviewWindow, op: &str, args: Value) -> Result<Value> {
    let app = window.app_handle();
    let desktop = app.state::<Desktop>();
    match op {
        "snapshot" => {
            let mut snapshot = desktop.read(|state| result(state))?;
            snapshot["cacheBytes"] = cache_bytes(&desktop.data.join("publications")).into();
            Ok(snapshot)
        }
        "scan" => scan(window, &desktop, args["force"].as_bool().unwrap_or(true)),
        "folderAdd" => {
            let Some(path) = selected(
                app.dialog()
                    .file()
                    .set_title("Choose an ebook folder")
                    .blocking_pick_folder(),
            )?
            else {
                return Ok(Value::Null);
            };
            let path = scanner::canonical_directory(&path)?;
            desktop.change(|state| {
                if !state.folders.iter().any(|folder| folder.path == path) {
                    state.folders.push(Folder {
                        id: id(),
                        path,
                        available: true,
                        exclusions: vec![],
                    });
                }
                Ok(())
            })?;
            scan(window, &desktop, true)
        }
        "folderRemove" => {
            let id = text(&args, "id")?;
            desktop.change(|state| {
                state.folders.retain(|folder| folder.id != id);
                Ok(())
            })?;
            scan(window, &desktop, true)
        }
        "folderExclude" => {
            let id = text(&args, "id")?;
            let root = desktop.read(|state| {
                Ok(state
                    .folders
                    .iter()
                    .find(|folder| folder.id == id)
                    .ok_or_else(|| anyhow!("Folder not found."))?
                    .path
                    .clone())
            })?;
            let Some(path) = selected(
                app.dialog()
                    .file()
                    .set_title("Exclude a subfolder")
                    .set_directory(&root)
                    .blocking_pick_folder(),
            )?
            else {
                return Ok(Value::Null);
            };
            let path = scanner::canonical_directory(&path)?;
            ensure!(
                path != root && Path::new(&path).starts_with(&root),
                "Pick a subfolder inside {root}."
            );
            desktop.change(|state| {
                let folder = folder_mut(state, id)?;
                if !folder.exclusions.contains(&path) {
                    folder.exclusions.push(path);
                }
                Ok(())
            })?;
            scan(window, &desktop, true)
        }
        "folderUnexclude" => {
            let id = text(&args, "id")?;
            let path = text(&args, "path")?;
            desktop.change(|state| {
                folder_mut(state, id)?
                    .exclusions
                    .retain(|entry| entry != path);
                Ok(())
            })?;
            scan(window, &desktop, true)
        }
        "cacheClear" => {
            publication::clear(&desktop)?;
            Ok(Value::Null)
        }
        "settingsPatch" => {
            let patch = args["patch"]
                .as_object()
                .ok_or_else(|| anyhow!("Expected settings."))?;
            desktop.change(|state| {
                let settings = state.settings.as_object_mut().expect("validated settings");
                for (key, value) in patch {
                    if matches!(
                        key.as_str(),
                        "backupFolder" | "lastWeeklyBackupAt" | "dictionaryPath"
                    ) {
                        continue;
                    }
                    if key == "formats" {
                        let formats: Vec<String> = decode(value)?;
                        ensure!(
                            formats
                                .iter()
                                .all(|format| FORMATS.contains(&format.as_str())),
                            "Unknown book format."
                        );
                    }
                    settings.insert(key.clone(), value.clone());
                }
                catalog::populate_series(state);
                Ok(())
            })?;
            Ok(Value::Null)
        }
        "importFont" => {
            let Some(path) = selected(
                app.dialog()
                    .file()
                    .set_title("Import a reader font")
                    .add_filter("Reader font", &["ttf", "otf"])
                    .blocking_pick_file(),
            )?
            else {
                return Ok(Value::Null);
            };
            ensure!(
                fs::metadata(&path)?.len() <= 8 * 1024 * 1024,
                "The font must be smaller than 8 MB."
            );
            let bytes = fs::read(&path)?;
            let mime = match bytes.get(..4) {
                Some(b"OTTO") => "font/otf",
                Some(b"\x00\x01\x00\x00" | b"true") => "font/ttf",
                _ => bail!("Choose a valid TTF or OTF font."),
            };
            let name = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Imported font");
            let font = json!({"id": id(), "name": name, "data": format!("data:{mime};base64,{}", STANDARD.encode(bytes))});
            desktop.change(|state| {
                if !state.settings["importedFonts"].is_array() {
                    state.settings["importedFonts"] = json!([]);
                }
                let fonts = state.settings["importedFonts"]
                    .as_array_mut()
                    .expect("font list");
                fonts.push(font.clone());
                Ok(())
            })?;
            Ok(font)
        }
        "chooseDictionary" => {
            ensure!(
                cfg!(windows),
                "Installed dictionaries are supported on Windows."
            );
            let Some(path) = selected(
                app.dialog()
                    .file()
                    .set_title("Choose an installed dictionary")
                    .add_filter("Windows executable", &["exe"])
                    .blocking_pick_file(),
            )?
            else {
                return Ok(Value::Null);
            };
            let path = dunce_path(&path)?;
            ensure!(
                path.is_file()
                    && path
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe")),
                "Choose a dictionary executable."
            );
            let value = path
                .to_str()
                .ok_or_else(|| anyhow!("Unsupported dictionary path."))?
                .to_owned();
            desktop.change(|state| {
                state.settings["dictionaryPath"] = value.clone().into();
                Ok(())
            })?;
            Ok(value.into())
        }
        "clearDictionary" => desktop.change(|state| {
            state.settings["dictionaryPath"] = Value::Null;
            Ok(Value::Null)
        }),
        "defineSelection" => {
            let term = text(&args, "text")?.trim();
            ensure!(
                term.chars().count() <= 180
                    && !term.starts_with('-')
                    && !term.chars().any(char::is_control),
                "Select a short word or phrase to look up."
            );
            let path = desktop.read(|state| {
                Ok(state.settings["dictionaryPath"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Choose an installed dictionary in reader settings."))?
                    .to_owned())
            })?;
            let executable = Path::new(&path);
            ensure!(
                cfg!(windows) && executable.is_absolute() && executable.is_file(),
                "The configured dictionary cannot be found."
            );
            let mut child = std::process::Command::new(executable)
                .arg(term)
                .spawn()
                .context("Opening the dictionary")?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(Value::Null)
        }
        "backupFolder" => {
            let Some(path) = selected(
                app.dialog()
                    .file()
                    .set_title("Choose an automatic backup folder")
                    .blocking_pick_folder(),
            )?
            else {
                return Ok(Value::Null);
            };
            let path = scanner::canonical_directory(&path)?;
            desktop.change(|state| {
                state.settings["backupFolder"] = path.clone().into();
                state.settings["lastWeeklyBackupAt"] = Value::Null;
                Ok(())
            })?;
            Ok(path.into())
        }
        "open" => {
            let book = desktop.source(text(&args, "bookId")?)?;
            publication::open(&desktop, &book)
        }
        "beginReading" => desktop.change_with_visit(|state, active| {
            let mode = if args["mode"].is_null() {
                tracking::Mode::Normal
            } else {
                decode(&args["mode"])?
            };
            let visit = tracking::visit(state, text(&args, "bookId")?, mode, now())?;
            let reading_id = visit.session.id.clone();
            *active = Some(visit);
            Ok(json!({"readingId": reading_id}))
        }),
        "readingUpdate" => {
            let input: tracking::Checkpoint = decode(&args)?;
            desktop.change_with_visit(|state, active| {
                let Some(visit) = active
                    .as_mut()
                    .filter(|visit| visit.session.id == input.reading_id)
                else {
                    return Ok(Value::Null);
                };
                let closed = input.closed;
                visit.update(state, input, now())?;
                if closed {
                    *active = None;
                }
                Ok(Value::Null)
            })
        }
        "finishPrompt" => {
            let book_id = text(&args, "bookId")?;
            desktop.change_with_visit(|state, active| {
                let shown = active
                    .as_mut()
                    .filter(|visit| visit.session.book_id == book_id)
                    .is_some_and(|visit| visit.finish_prompt(state));
                Ok(shown.into())
            })
        }
        "bookState" => desktop.change_with_visit(|state, active| {
            let outcome: BookState = decode(&args["outcome"])?;
            let zone = args["zoneOffsetMinutes"]
                .as_i64()
                .unwrap_or_default()
                .clamp(-840, 840) as i32;
            for id in book_ids(&args)? {
                tracking::set_state(
                    state,
                    &id,
                    outcome,
                    args["date"].as_i64(),
                    zone,
                    now(),
                    active.as_mut(),
                )?;
            }
            Ok(Value::Null)
        }),
        "runEdit" => desktop.change(|state| {
            let start = args["startedAt"]
                .as_i64()
                .ok_or_else(|| anyhow!("Choose a start date."))?;
            tracking::edit_run(state, text(&args, "id")?, start, args["endedAt"].as_i64())?;
            Ok(Value::Null)
        }),
        "runDelete" => desktop.change(|state| {
            tracking::delete_run(state, text(&args, "id")?)?;
            Ok(Value::Null)
        }),
        "bookPatch" => desktop.change(|state| {
            for id in book_ids(&args)? {
                patch_book(catalog::book_mut(state, &id)?, &args)?;
            }
            if ["ignored", "overrides"]
                .iter()
                .any(|key| args.get(key).is_some())
            {
                state.rebuild_authors();
                catalog::populate_series(state);
            }
            Ok(Value::Null)
        }),
        "bookCover" | "categoryCover" => {
            let Some(path) = selected(
                app.dialog()
                    .file()
                    .set_title("Choose a cover image")
                    .add_filter("Image", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
                    .blocking_pick_file(),
            )?
            else {
                return Ok(Value::Null);
            };
            let cover = cover_image(&path)?;
            desktop.change(|state| {
                if op == "bookCover" {
                    let book = catalog::book_mut(state, text(&args, "bookId")?)?;
                    book.overrides.cover = Some(cover);
                    book.apply_metadata();
                } else {
                    catalog::category_mut(state, text(&args, "id")?)?.cover = Some(cover);
                }
                Ok(Value::Null)
            })
        }
        "bookForget" => desktop.change_with_visit(|state, visit| {
            let id = text(&args, "bookId")?;
            if visit
                .as_ref()
                .is_some_and(|current| current.session.book_id == id)
            {
                *visit = None;
            }
            catalog::forget(state, id)?;
            Ok(Value::Null)
        }),
        "categoryCreate" => desktop.change(|state| {
            result(catalog::create_category(
                state,
                text(&args, "name")?,
                optional_text(&args, "description"),
                string_list(&args, "typeIds")?,
            )?)
        }),
        "categoryPatch" => desktop.change(|state| {
            let types = args.get("typeIds").map(decode::<Vec<String>>).transpose()?;
            if let Some(types) = &types {
                catalog::validate_types(state, types)?;
            }
            let category = catalog::category_mut(state, text(&args, "id")?)?;
            if args.get("name").is_some() {
                category.name = text(&args, "name")?.trim().into();
            }
            if let Some(description) = args["description"].as_str() {
                category.description = description.trim().into();
            }
            if let Some(types) = types {
                category.type_ids = types;
            }
            if let Some(order) = args["orderMode"].as_str() {
                ensure!(
                    ["manual", "title", "author", "added", "rating"].contains(&order),
                    "Unknown category sort."
                );
                category.order_mode = order.into();
            }
            if let Some(rating) = args.get("rating") {
                category.rating = catalog::rating(rating)?;
            }
            if args.get("clearCover").and_then(Value::as_bool) == Some(true) {
                category.cover = None;
            }
            Ok(Value::Null)
        }),
        "categoryMembership" => desktop.change(|state| {
            catalog::membership(
                state,
                text(&args, "id")?,
                &book_ids(&args)?,
                text(&args, "action")?,
                args["position"].as_f64(),
            )?;
            Ok(Value::Null)
        }),
        "categoryOrder" => desktop.change(|state| {
            catalog::reorder(state, text(&args, "id")?, &string_list(&args, "ids")?)?;
            Ok(Value::Null)
        }),
        "categoryDelete" => desktop.change(|state| {
            catalog::remove_category(state, text(&args, "id")?)?;
            Ok(Value::Null)
        }),
        "categoryMerge" | "authorMerge" => desktop.change(|state| {
            let source = text(&args, "source")?;
            let target = text(&args, "target")?;
            if op == "categoryMerge" {
                catalog::merge_categories(state, source, target)?;
            } else {
                catalog::merge_authors(state, source, target)?;
            }
            Ok(Value::Null)
        }),
        "typeSave" => desktop.change(|state| {
            result(catalog::set_type(
                state,
                args["id"].as_str(),
                text(&args, "name")?,
            )?)
        }),
        "typeDelete" => desktop.change(|state| {
            catalog::remove_type(state, text(&args, "id")?)?;
            Ok(Value::Null)
        }),
        "authorRename" => desktop.change(|state| {
            catalog::rename_author(state, text(&args, "id")?, text(&args, "name")?)?;
            Ok(Value::Null)
        }),
        "noteSave" => desktop.change(|state| {
            let mut note: Annotation = decode(&args["annotation"])?;
            catalog::book(state, &note.book_id)?;
            ensure!(
                matches!(note.kind.as_str(), "highlight" | "bookmark" | "page"),
                "Unknown annotation type."
            );
            if !["purple", "green", "amber", "grey", "gray", "neutral"]
                .contains(&note.color.as_str())
            {
                note.color = "purple".into();
            }
            note.updated_at = now();
            if note.id.is_empty() {
                note.id = id();
                note.created_at = now();
                state.annotations.push(note.clone());
            } else {
                let previous = state
                    .annotations
                    .iter_mut()
                    .find(|existing| existing.id == note.id && existing.book_id == note.book_id)
                    .ok_or_else(|| anyhow!("Annotation not found."))?;
                note.created_at = previous.created_at;
                *previous = note.clone();
            }
            result(note)
        }),
        "noteDelete" => desktop.change(|state| {
            let id = text(&args, "id")?;
            state.annotations.retain(|note| note.id != id);
            Ok(Value::Null)
        }),
        "matchCandidates" => {
            let id = text(&args, "bookId")?;
            let (book, settings) = desktop.read(|state| {
                Ok((
                    serde_json::to_value(catalog::book(state, id)?)?,
                    state.settings.clone(),
                ))
            })?;
            result(matching::candidates(&book, &settings)?)
        }
        "matchConfirm" => desktop.change(|state| {
            let book = catalog::book_mut(state, text(&args, "bookId")?)?;
            if args["edition"].is_null() {
                book.edition = None;
            } else {
                let mut edition = args["edition"].clone();
                text(&edition, "title")?;
                text(&edition, "provider")?;
                edition["confirmedAt"] = now().into();
                book.edition = Some(edition);
            }
            Ok(Value::Null)
        }),
        "matchMetadata" => desktop.change(|state| {
            let book = catalog::book_mut(state, text(&args, "bookId")?)?;
            let edition = book
                .edition
                .as_ref()
                .ok_or_else(|| anyhow!("Match an edition first."))?;
            book.overrides.title = Some(text(edition, "title")?.into());
            book.overrides.authors = Some(string_list(edition, "authors")?);
            state.rebuild_authors();
            Ok(Value::Null)
        }),
        "matchCover" => {
            let id = text(&args, "bookId")?;
            let url = desktop.read(|state| {
                let book = catalog::book(state, id)?;
                Ok(text(
                    book.edition
                        .as_ref()
                        .ok_or_else(|| anyhow!("Match an edition first."))?,
                    "coverUrl",
                )?
                .to_owned())
            })?;
            let cover = matching::cover(&url)?;
            desktop.change(|state| {
                let book = catalog::book_mut(state, id)?;
                ensure!(
                    book.edition
                        .as_ref()
                        .and_then(|edition| edition["coverUrl"].as_str())
                        == Some(url.as_str()),
                    "The matched edition changed before the cover finished downloading."
                );
                book.overrides.cover = Some(cover);
                book.apply_metadata();
                Ok(Value::Null)
            })
        }
        "unmatchedCount" => {
            desktop.read(|state| result(exchange::unmatched_count(&serde_json::to_value(state)?)))
        }
        "exportToFile" => export(window, &desktop, &args),
        "restoreBackup" => {
            let Some(path) = selected(
                app.dialog()
                    .file()
                    .set_title("Restore a Deft backup")
                    .add_filter("Deft backup", &["zip"])
                    .blocking_pick_file(),
            )?
            else {
                return Ok(Value::Null);
            };
            ensure!(
                fs::metadata(&path)?.len() <= 512 * 1024 * 1024,
                "The backup exceeds the 512 MB limit."
            );
            let folders = desktop.restore(&fs::read(path)?)?;
            Ok(json!({"folders": folders}))
        }
        "closeWindow" => {
            window.destroy()?;
            Ok(Value::Null)
        }
        "fullscreen" => {
            window.set_fullscreen(args["value"].as_bool().unwrap_or(false))?;
            Ok(Value::Null)
        }
        "keepAwake" => {
            let active =
                args["value"].as_bool().unwrap_or(false) && window.is_focused().unwrap_or(false);
            window.run_on_main_thread(move || keep_awake(active))?;
            Ok(Value::Null)
        }
        _ => bail!("Unknown Deft command."),
    }
}

fn scan(window: &WebviewWindow, desktop: &Desktop, force: bool) -> Result<Value> {
    let report = desktop.scan(force)?;
    let handle = window.app_handle().clone();
    if !report.skipped {
        let _ = window.emit("deft:scan", &report);
        tauri::async_runtime::spawn_blocking(move || {
            publication::prewarm(&handle.state::<Desktop>())
        });
    }
    result(report)
}

fn folder_mut<'a>(state: &'a mut State, id: &str) -> Result<&'a mut Folder> {
    state
        .folders
        .iter_mut()
        .find(|folder| folder.id == id)
        .ok_or_else(|| anyhow!("Folder not found."))
}

fn book_ids(args: &Value) -> Result<Vec<String>> {
    if let Some(id) = args["bookId"].as_str() {
        return Ok(vec![id.into()]);
    }
    let ids = string_list(args, "bookIds")?;
    ensure!(!ids.is_empty(), "Select at least one book.");
    Ok(ids)
}

fn patch_book(book: &mut deft_core::model::Book, args: &Value) -> Result<()> {
    if let Some(ignored) = args["ignored"].as_bool() {
        book.ignored = ignored;
    }
    if let Some(favorite) = args["favorite"].as_bool() {
        book.favorite = favorite;
    }
    if let Some(review) = args["review"].as_str() {
        book.review = review.into();
    }
    if let Some(rating) = args.get("rating") {
        book.rating = catalog::rating(rating)?;
    }
    if let Some(fixed) = args.get("fixed") {
        book.fixed = fixed.clone();
    }
    if let Some(overrides) = args.get("overrides").and_then(Value::as_object) {
        let mut current = serde_json::to_value(&book.overrides)?;
        for key in ["title", "authors", "series", "seriesIndex", "cover"] {
            if let Some(value) = overrides.get(key) {
                current[key] = value.clone();
            }
        }
        book.overrides = decode(&current)?;
        if let Some(title) = book.overrides.title.as_mut() {
            *title = title.trim().into();
            if title.is_empty() {
                book.overrides.title = None;
            }
        }
        book.apply_metadata();
    }
    Ok(())
}

fn dunce_path(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(path).context("Opening the selected file")
}

fn cover_image(path: &Path) -> Result<String> {
    ensure!(
        fs::metadata(path)?.len() <= 24 * 1024 * 1024,
        "The cover must be smaller than 24 MB."
    );
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode()?.thumbnail(416, 624);
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png)?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes.into_inner())
    ))
}

fn export(window: &WebviewWindow, desktop: &Desktop, args: &Value) -> Result<Value> {
    let kind = text(args, "kind")?;
    let date = chrono::Local::now().format("%Y-%m-%d");
    let (filename, extension) = match kind {
        "csv" => (format!("deft-goodreads-{date}.csv"), "csv"),
        "profile" => (format!("deft-profile-{date}.json"), "json"),
        "backup" => (format!("deft-backup-{date}.zip"), "zip"),
        "notes" => ("deft-book-notes.md".into(), "md"),
        _ => bail!("Unknown export format."),
    };
    let Some(path) = selected(
        window
            .app_handle()
            .dialog()
            .file()
            .set_title("Save Deft export")
            .set_file_name(&filename)
            .add_filter("Deft export", &[extension])
            .blocking_save_file(),
    )?
    else {
        return Ok(Value::Null);
    };
    ensure!(
        path.extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
            && deft_core::formats::format(&path).is_none(),
        "Choose a .{extension} filename for this export."
    );
    let destination = path
        .parent()
        .map(dunce_path)
        .transpose()?
        .ok_or_else(|| anyhow!("Choose a destination folder."))?;
    ensure!(
        !destination.starts_with(&desktop.data),
        "Save the export outside Deft’s app-data folder."
    );
    let bytes = if kind == "backup" {
        desktop.archive()?
    } else {
        let state: Value = desktop.read(|state| result(state))?;
        match kind {
            "csv" => exchange::goodreads(&state, &args["options"])?,
            "profile" => exchange::profile(&state, &args["options"])?,
            "notes" => exchange::notes(&state, text(args, "bookId")?)?,
            _ => unreachable!(),
        }
    };
    let mut output = tempfile::NamedTempFile::new_in(destination)?;
    output.write_all(&bytes)?;
    output.as_file().sync_all()?;
    output.persist(&path).context("Saving the export")?;
    Ok(json!({"path": path}))
}
