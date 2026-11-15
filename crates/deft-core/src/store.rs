// SPDX-License-Identifier: GPL-3.0-only
use crate::model::State;
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    time::Duration,
};

const SCHEMA: i64 = 2;
const COLLECTIONS: &[&str] = &[
    "books",
    "authors",
    "categories",
    "types",
    "annotations",
    "readThroughs",
    "sessions",
    "folders",
];

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDelta {
    pub rows: Map<String, Value>,
    pub fields: Map<String, Value>,
    #[serde(skip)]
    pub bytes: usize,
}

impl LibraryDelta {
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.fields.is_empty()
    }
}

pub struct Store {
    connection: Connection,
}

fn migrate(connection: &mut Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA {
        bail!("This data was created by a newer version of Deft.");
    }
    if version == SCHEMA {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS records (
            key TEXT PRIMARY KEY NOT NULL,
            payload TEXT NOT NULL CHECK (json_valid(payload))
         ) WITHOUT ROWID;
         CREATE TABLE items (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            payload TEXT NOT NULL CHECK (json_valid(payload)),
            PRIMARY KEY(collection,id)
         ) WITHOUT ROWID;",
    )?;
    for collection in COLLECTIONS {
        transaction.execute(
            "INSERT INTO items(collection,id,ordinal,payload)
             SELECT records.key, json_extract(entry.value,'$.id'), entry.key,
               CASE WHEN records.key='books' THEN json_remove(entry.value,'$.cover') ELSE entry.value END
             FROM records, json_each(records.payload) AS entry WHERE records.key=?1",
            [collection],
        )?;
        transaction.execute("DELETE FROM records WHERE key=?1", [collection])?;
    }
    if version == 0 {
        for (ordinal, entry) in State::default().types.iter().enumerate() {
            transaction.execute(
                "INSERT OR IGNORE INTO items VALUES ('types',?1,?2,?3)",
                params![entry.id, ordinal, serde_json::to_string(entry)?],
            )?;
        }
    }
    // The former standard budget matched the default baked into every v1 library.
    transaction.execute(
        "UPDATE records SET payload=json_set(payload,'$.cacheLimitMb',128)
         WHERE key='settings' AND json_extract(payload,'$.cacheLimitMb')=1024",
        [],
    )?;
    transaction.execute(
        "INSERT OR IGNORE INTO records(key,payload) VALUES ('settings', ?1)",
        [serde_json::to_string(&State::default().settings)?],
    )?;
    transaction.pragma_update(None, "user_version", SCHEMA)?;
    transaction.commit()?;
    Ok(())
}

fn public_book(value: &mut Value) {
    if let Some(meta) = value["metadata"].as_object_mut() {
        meta.remove("cover");
    }
    if let Some(overrides) = value["overrides"].as_object_mut() {
        overrides.remove("cover");
    }
}

pub fn public_snapshot(state: &State) -> Result<Value> {
    let mut snapshot = serde_json::to_value(state)?;
    if let Some(books) = snapshot["books"].as_array_mut() {
        books.iter_mut().for_each(public_book);
    }
    if let Some(object) = snapshot.as_object_mut() {
        for key in [
            "authorAliases",
            "authorNames",
            "seriesAliases",
            "seriesDismissed",
        ] {
            object.remove(key);
        }
    }
    Ok(snapshot)
}

fn sync_rows<T: Serialize + PartialEq>(
    transaction: &Transaction<'_>,
    collection: &str,
    previous: &[T],
    next: &[T],
    id: impl Fn(&T) -> &str,
    delta: &mut LibraryDelta,
) -> Result<()> {
    if previous == next {
        return Ok(());
    }
    let mut old: HashMap<_, _> = previous
        .iter()
        .enumerate()
        .map(|(index, row)| (id(row), (index, row)))
        .collect();
    let mut identifiers = HashSet::with_capacity(next.len());
    let mut added_or_changed = Vec::new();
    let mut order_changed = previous.len() != next.len();
    let mut put = transaction.prepare_cached(
        "INSERT INTO items(collection,id,ordinal,payload) VALUES (?1,?2,?3,?4)
         ON CONFLICT(collection,id) DO UPDATE SET ordinal=excluded.ordinal,payload=excluded.payload",
    )?;
    let mut reorder =
        transaction.prepare_cached("UPDATE items SET ordinal=?3 WHERE collection=?1 AND id=?2")?;
    for (index, row) in next.iter().enumerate() {
        let row_id = id(row);
        ensure!(
            !row_id.is_empty() && identifiers.insert(row_id),
            "Invalid or duplicate identifier in {collection}."
        );
        let before = old.remove(row_id);
        let moved = before.is_none_or(|(prior_index, _)| prior_index != index);
        order_changed |= moved;
        if before.is_none_or(|(_, prior)| prior != row) {
            let mut serialized = serde_json::to_value(row)?;
            let cover = if collection == "books" {
                serialized
                    .as_object_mut()
                    .and_then(|object| object.remove("cover"))
            } else {
                None
            };
            let payload = serde_json::to_string(&serialized)?;
            put.execute(params![collection, id(row), index, payload])?;
            delta.bytes = delta.bytes.saturating_add(payload.len());
            if collection == "books" {
                public_book(&mut serialized);
                serialized["cover"] = cover.unwrap_or(Value::Null);
            }
            added_or_changed.push(serialized);
        } else if moved {
            reorder.execute(params![collection, id(row), index])?;
        }
    }
    let removed: Vec<_> = old.into_keys().collect();
    let mut delete =
        transaction.prepare_cached("DELETE FROM items WHERE collection=?1 AND id=?2")?;
    for row_id in &removed {
        delete.execute(params![collection, row_id])?;
    }
    let order = order_changed.then(|| next.iter().map(id).collect::<Vec<_>>());
    delta.bytes += removed.iter().map(|id| id.len()).sum::<usize>();
    if let Some(ids) = &order {
        delta.bytes += ids.iter().map(|id| id.len()).sum::<usize>();
    }
    delta.rows.insert(
        collection.into(),
        json!({"upsert": added_or_changed, "remove": removed, "order": order}),
    );
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path).context("Opening the Deft database")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;",
        )?;
        migrate(&mut connection)?;
        Ok(Self { connection })
    }

    pub fn load(&self) -> Result<State> {
        let mut object = Map::new();
        let mut statement = self.connection.prepare("SELECT key,payload FROM records")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (key, payload) = row?;
            object.insert(key, serde_json::from_str(&payload)?);
        }
        for collection in COLLECTIONS {
            object.insert((*collection).into(), Value::Array(Vec::new()));
        }
        let mut statement = self
            .connection
            .prepare("SELECT collection,payload FROM items ORDER BY collection,ordinal")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (collection, payload) = row?;
            if let Some(entries) = object.get_mut(&collection).and_then(Value::as_array_mut) {
                entries.push(serde_json::from_str(&payload)?);
            }
        }
        let mut state: State = serde_json::from_value(Value::Object(object))?;
        let settings = state
            .settings
            .as_object_mut()
            .context("The database contains invalid settings")?;
        for (key, value) in State::default()
            .settings
            .as_object()
            .expect("settings defaults")
        {
            settings.entry(key.clone()).or_insert_with(|| value.clone());
        }
        state.books.iter_mut().for_each(|book| book.update_cover());
        Ok(state)
    }

    pub fn save(&mut self, state: &State) -> Result<()> {
        let previous = self.load()?;
        self.save_updates(&previous, state)?;
        Ok(())
    }

    /// Writes only changed items and keeps related changes in a single transaction.
    /// Returned frontend rows omit duplicate artwork and internal aliases.
    pub fn save_updates(&mut self, previous: &State, next: &State) -> Result<LibraryDelta> {
        let transaction = self.connection.transaction()?;
        let mut delta = LibraryDelta::default();
        macro_rules! rows {
            ($($field:ident : $key:literal),* $(,)?) => {
                $(sync_rows(&transaction, $key, &previous.$field, &next.$field, |row| &row.id, &mut delta)?;)*
            };
        }
        rows!(books: "books", authors: "authors", categories: "categories", types: "types",
            annotations: "annotations", read_throughs: "readThroughs", sessions: "sessions", folders: "folders");
        let mut write = transaction.prepare_cached(
            "INSERT INTO records(key,payload) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
        )?;
        macro_rules! field {
            ($field:ident : $key:literal, $public:expr) => {
                if previous.$field != next.$field {
                    let value = serde_json::to_value(&next.$field)?;
                    let encoded = serde_json::to_string(&value)?;
                    write.execute(params![$key, encoded])?;
                    if $public {
                        delta.bytes += encoded.len();
                        delta.fields.insert($key.into(), value);
                    }
                }
            };
        }
        field!(settings: "settings", true);
        field!(last_scan: "lastScan", true);
        field!(author_aliases: "authorAliases", false);
        field!(author_names: "authorNames", false);
        field!(series_aliases: "seriesAliases", false);
        field!(series_dismissed: "seriesDismissed", false);
        drop(write);
        transaction.commit()?;
        Ok(delta)
    }

    pub fn backup(&self, directory: &Path) -> Result<Vec<u8>> {
        let temporary = tempfile::tempdir_in(directory)?;
        let file = temporary.path().join("deft.sqlite3");
        self.connection
            .execute("VACUUM INTO ?1", [file.to_string_lossy().as_ref()])?;
        Ok(fs::read(file)?)
    }

    pub fn decode_backup(directory: &Path, bytes: &[u8]) -> Result<State> {
        if !bytes.starts_with(b"SQLite format 3\0") {
            bail!("The archive does not contain a Deft database.");
        }
        let temporary = tempfile::tempdir_in(directory)?;
        let path = temporary.path().join("restore.sqlite3");
        fs::write(&path, bytes)?;
        let version_bytes: [u8; 4] = bytes
            .get(60..64)
            .context("Incomplete Deft database")?
            .try_into()?;
        if u32::from_be_bytes(version_bytes) == 0 {
            bail!("The backup does not contain a versioned Deft database.");
        }
        let store = Self::open(&path)?;
        let healthy: String =
            store
                .connection
                .query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
        if healthy != "ok" {
            bail!("The backup database is damaged.");
        }
        let exists: Option<i64> = store
            .connection
            .query_row("SELECT 1 FROM records WHERE key='settings'", [], |row| {
                row.get(0)
            })
            .optional()?;
        if exists.is_none() {
            bail!("The backup does not contain Deft settings.");
        }
        store.load()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Book;

    #[test]
    fn migrates_v1_rows_and_round_trips_a_consistent_backup() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("app.db");
        let legacy = Connection::open(&path)?;
        legacy.execute_batch(
            r#"CREATE TABLE records(key TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL);
             INSERT INTO records VALUES ('books','[{"id":"old","metadata":{"cover":"data:image/jpeg;base64,cover"},"favorite":true}]');
             INSERT INTO records VALUES ('settings','{"cacheLimitMb":1024,"readerFontSize":23}');
             PRAGMA user_version=1;"#,
        )?;
        drop(legacy);
        let mut store = Store::open(&path)?;
        let mut state = store.load()?;
        assert_eq!(state.books[0].id, "old");
        assert!(state.books[0].favorite);
        assert!(state.books[0].cover.is_some());
        assert_eq!(state.settings["cacheLimitMb"], 128);
        assert_eq!(state.settings["readerFontSize"], 23);
        state.books.push(Book {
            id: "new".into(),
            ..Book::default()
        });
        store.save(&state)?;
        let backup = store.backup(directory.path())?;
        let restored = Store::decode_backup(directory.path(), &backup)?;
        assert_eq!(restored.books.len(), 2);
        assert_eq!(restored.books[0].id, "old");
        assert_eq!(restored.books[1].id, "new");
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "user_version", SCHEMA + 1)?;
        assert!(Store::open(&directory.path().join("app.db")).is_err());
        Ok(())
    }

    #[test]
    fn edits_and_restores_use_individual_rows_in_order() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let mut store = Store::open(&directory.path().join("app.db"))?;
        let mut state = store.load()?;
        let cover: std::sync::Arc<str> =
            format!("data:image/jpeg;base64,{}", "Q".repeat(16 * 1024)).into();
        state.books = (0..1000)
            .map(|index| {
                let mut book = Book {
                    id: index.to_string(),
                    ..Book::default()
                };
                book.metadata.cover = Some(cover.clone());
                book.update_cover();
                book
            })
            .collect();
        store.save(&state)?;

        let mut edited = state.clone();
        edited.books[700].favorite = true;
        let before: usize = store
            .connection
            .query_row("SELECT total_changes()", [], |row| row.get(0))?;
        let delta = store.save_updates(&state, &edited)?;
        let after: usize = store
            .connection
            .query_row("SELECT total_changes()", [], |row| row.get(0))?;
        assert_eq!(after - before, 1);
        assert_eq!(delta.rows["books"]["upsert"].as_array().unwrap().len(), 1);
        assert_eq!(delta.rows["books"]["upsert"][0]["id"], "700");
        assert!(delta.rows["books"]["order"].is_null());
        assert!(serde_json::to_vec(&delta)?.len() < 20 * 1024);
        assert!(delta.rows["books"]["upsert"][0]["metadata"]["cover"].is_null());
        assert!(store.load()?.books[700].favorite);

        let mut replaced = edited.clone();
        replaced.books.remove(20);
        replaced.books.swap(0, 1);
        let delta = store.save_updates(&edited, &replaced)?;
        assert_eq!(delta.rows["books"]["remove"], json!(["20"]));
        assert_eq!(delta.rows["books"]["order"][0], "1");
        assert_eq!(store.load()?.books, replaced.books);
        Ok(())
    }
}
