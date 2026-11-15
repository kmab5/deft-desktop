// SPDX-License-Identifier: GPL-3.0-only
use crate::model::State;
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use std::{fs, path::Path, time::Duration};

const SCHEMA: i64 = 1;

/// SQLite stores one versioned, transactional record per collection. Related updates
/// (such as a reading session, read-through and locator) commit together.
pub struct Store {
    connection: Connection,
}

fn migrate(connection: &mut Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA {
        bail!("This data was created by a newer version of Deft.");
    }
    if version == 0 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS records (
                key TEXT PRIMARY KEY NOT NULL,
                payload TEXT NOT NULL CHECK (json_valid(payload))
             ) WITHOUT ROWID;
             PRAGMA user_version = 1;",
        )?;
        transaction.commit()?;
    }
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

    fn read(connection: &Connection) -> Result<State> {
        let mut statement = connection.prepare("SELECT key, payload FROM records")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut object = Map::new();
        for row in rows {
            let (key, payload) = row?;
            object.insert(key, serde_json::from_str(&payload)?);
        }
        let mut state: State = serde_json::from_value(Value::Object(object))?;
        if !state.settings.is_object() {
            bail!("The backup contains invalid settings.");
        }
        let defaults = State::default();
        let settings = state.settings.as_object_mut().expect("checked above");
        for (key, value) in defaults.settings.as_object().expect("settings defaults") {
            settings.entry(key.clone()).or_insert_with(|| value.clone());
        }
        Ok(state)
    }

    pub fn load(&self) -> Result<State> {
        Self::read(&self.connection)
    }

    pub fn save(&mut self, state: &State) -> Result<()> {
        let serialized = serde_json::to_value(state)?;
        let transaction = self.connection.transaction()?;
        for (key, value) in serialized.as_object().expect("State is an object") {
            let payload = serde_json::to_string(value)?;
            transaction.execute(
                "INSERT INTO records(key,payload) VALUES (?1,?2)
                 ON CONFLICT(key) DO UPDATE SET payload=excluded.payload
                 WHERE payload<>excluded.payload",
                params![key, payload],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn backup(&self, directory: &Path) -> Result<Vec<u8>> {
        let temporary = tempfile::tempdir_in(directory)?;
        let file = temporary.path().join("deft.sqlite3");
        self.connection
            .execute("VACUUM INTO ?1", [file.to_string_lossy().as_ref()])?;
        Ok(fs::read(file)?)
    }

    /// Validate and fully decode a replacement away from the running database.
    /// Applying the resulting state is a normal atomic write.
    pub fn decode_backup(directory: &Path, bytes: &[u8]) -> Result<State> {
        if !bytes.starts_with(b"SQLite format 3\0") {
            bail!("The archive does not contain a Deft database.");
        }
        let temporary = tempfile::tempdir_in(directory)?;
        let path = temporary.path().join("restore.sqlite3");
        fs::write(&path, bytes)?;
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
    fn migrates_empty_database_and_round_trips_a_consistent_backup() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("app.db");
        Connection::open(&path)?;
        let mut store = Store::open(&path)?;
        let mut state = store.load()?;
        state.books.push(Book {
            id: "sha".into(),
            ..Book::default()
        });
        store.save(&state)?;
        let backup = store.backup(directory.path())?;
        assert_eq!(
            Store::decode_backup(directory.path(), &backup)?.books[0].id,
            "sha"
        );
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "user_version", SCHEMA + 1)?;
        assert!(Store::open(&directory.path().join("app.db")).is_err());
        Ok(())
    }
}
