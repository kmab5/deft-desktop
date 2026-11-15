// SPDX-License-Identifier: GPL-3.0-only
use crate::formats::Metadata;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

macro_rules! model {
    ($name:ident { $($fields:tt)* }) => {
        #[derive(Clone, Debug, Default, Serialize, Deserialize)]
        #[serde(default, rename_all = "camelCase")]
        pub struct $name { $($fields)* }
    };
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BookState {
    #[default]
    NotRead,
    Reading,
    Finished,
    Paused,
    Abandoned,
}

model!(Locator {
    pub chapter: usize,
    pub offset: usize,
    pub progress: f64,
    pub position: usize,
    pub href: Option<String>,
    pub page: Option<usize>,
});

model!(BookFile {
    pub path: String,
    pub size: u64,
    pub modified: u64,
    pub missing: bool,
    pub last_seen_at: i64,
});

model!(Overrides {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub cover: Option<String>,
});

model!(Book {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub author_ids: Vec<String>,
    pub format: String,
    pub metadata: Metadata,
    pub overrides: Overrides,
    pub files: Vec<BookFile>,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    pub ignored: bool,
    pub missing: bool,
    pub state: BookState,
    pub marked_unread: bool,
    pub favorite: bool,
    pub rating: Option<f64>,
    pub review: String,
    pub progress: f64,
    pub locator: Option<Locator>,
    pub fixed: Value,
    pub cover: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub edition: Option<Value>,
    pub protected: bool,
    pub page_count: Option<usize>,
});

impl Book {
    pub fn apply_metadata(&mut self) {
        self.title = self
            .overrides
            .title
            .as_ref()
            .unwrap_or(&self.metadata.title)
            .clone();
        self.authors = self
            .overrides
            .authors
            .as_ref()
            .unwrap_or(&self.metadata.authors)
            .iter()
            .map(|name| author_display(name))
            .filter(|name| !name.is_empty())
            .collect();
        self.series = self
            .overrides
            .series
            .clone()
            .or_else(|| self.metadata.series.clone());
        self.series_index = self.overrides.series_index.or(self.metadata.series_index);
        self.cover = self
            .overrides
            .cover
            .clone()
            .or_else(|| self.metadata.cover.clone());
        self.page_count = self.metadata.page_count;
        self.protected = self.metadata.protected;
        self.missing = self.files.iter().all(|file| file.missing);
    }
}

model!(Author {
    pub id: String,
    pub name: String,
    pub book_ids: Vec<String>,
});

model!(CategoryType {
    pub id: String,
    pub name: String,
    pub built_in: bool,
});
model!(Member {
    pub book_id: String,
    pub position: f64,
    pub suggested: bool,
    pub added_at: i64,
});
model!(Category {
    pub id: String,
    pub name: String,
    pub description: String,
    pub type_ids: Vec<String>,
    pub members: Vec<Member>,
    pub rating: Option<f64>,
    pub cover: Option<String>,
    pub order_mode: String,
    pub sort_reversed: bool,
    pub auto_created: bool,
    pub parent_id: Option<String>,
    pub created_at: i64,
});

model!(Annotation {
    pub id: String,
    pub book_id: String,
    pub kind: String,
    pub locator: Locator,
    pub text: String,
    pub note: String,
    pub color: String,
    pub end: Option<usize>,
    pub created_at: i64,
    pub updated_at: i64,
});
model!(ReadThrough {
    pub id: String,
    pub book_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub outcome: BookState,
    pub prompted: bool,
    pub zone_offset_minutes: i32,
});
model!(Session {
    pub id: String,
    pub book_id: String,
    pub read_through_id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub active_seconds: u64,
    pub browsing: bool,
    pub zone_offset_minutes: i32,
    pub start_locator: Locator,
    pub end_locator: Locator,
    pub pages_turned: u64,
});
model!(Folder {
    pub id: String,
    pub path: String,
    pub exclusions: Vec<String>,
    pub available: bool,
});

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub books: Vec<Book>,
    pub authors: Vec<Author>,
    pub categories: Vec<Category>,
    pub types: Vec<CategoryType>,
    pub annotations: Vec<Annotation>,
    pub read_throughs: Vec<ReadThrough>,
    pub sessions: Vec<Session>,
    pub folders: Vec<Folder>,
    pub settings: Value,
    pub author_aliases: BTreeMap<String, String>,
    pub author_names: BTreeMap<String, String>,
    pub series_aliases: BTreeMap<String, String>,
    pub series_dismissed: BTreeSet<(String, String)>,
    pub last_scan: Option<i64>,
}

pub const FORMATS: [&str; 9] = [
    "epub", "mobi", "azw", "azw3", "fb2", "txt", "pdf", "djvu", "cbz",
];

impl Default for State {
    fn default() -> Self {
        Self {
            books: vec![],
            authors: vec![],
            categories: vec![],
            annotations: vec![],
            read_throughs: vec![],
            sessions: vec![],
            folders: vec![],
            author_aliases: BTreeMap::new(),
            author_names: BTreeMap::new(),
            series_aliases: BTreeMap::new(),
            series_dismissed: BTreeSet::new(),
            last_scan: None,
            types: vec![CategoryType {
                id: "series".into(),
                name: "Series".into(),
                built_in: true,
            }],
            settings: json!({
                "formats": FORMATS, "seriesAutoFill": true, "prepareInBackground": true,
                "cacheLimitMb": 1024, "appTheme": "system", "celebrations": true,
                "reflowIdleMinutes": 5, "fixedIdleMinutes": 10, "minSessionSeconds": 60,
                "streakMinutes": 1, "trackingIndicator": false, "goals": {},
                "readerFont": "Literata", "readerFontSize": 19, "readerLineSpacing": 1.65,
                "readerTheme": "sepia", "readerKeepAwake": true,
                "matchingOpenLibrary": true, "matchingGoogleBooks": true, "matchingHardcover": true,
                "backupEnabled": false, "backupKeep": 4
            }),
        }
    }
}

pub fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn author_display(value: &str) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    match value.split_once(',') {
        Some((last, first)) if !first.trim().is_empty() && !first.contains(',') => {
            format!("{} {}", first.trim(), last.trim())
        }
        _ => value,
    }
}

impl State {
    pub fn rebuild_authors(&mut self) {
        let mut people: BTreeMap<String, Author> = BTreeMap::new();
        for book in &mut self.books {
            book.apply_metadata();
            let unique = book
                .authors
                .iter()
                .filter_map(|name| {
                    let key = normalized(name);
                    if key.is_empty() {
                        return None;
                    }
                    let id = self.author_aliases.get(&key).cloned().unwrap_or(key);
                    let display = self
                        .author_names
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| name.clone());
                    Some((id, display))
                })
                .collect::<Vec<_>>();
            book.authors.clear();
            book.author_ids.clear();
            for (id, name) in unique {
                if book.author_ids.contains(&id) {
                    continue;
                }
                let author = people.entry(id.clone()).or_insert_with(|| Author {
                    id: id.clone(),
                    name,
                    book_ids: vec![],
                });
                if !book.ignored {
                    author.book_ids.push(book.id.clone());
                }
                book.author_ids.push(id);
                book.authors.push(author.name.clone());
            }
        }
        self.authors = people
            .into_values()
            .filter(|author| !author.book_ids.is_empty())
            .collect();
    }

    pub fn sync_book_state(&mut self, book_id: &str) {
        if let Some(book) = self.books.iter_mut().find(|book| book.id == book_id) {
            if book.marked_unread {
                book.state = BookState::NotRead;
                return;
            }
            book.state = self
                .read_throughs
                .iter()
                .rev()
                .find(|run| run.book_id == book_id)
                .map(|run| run.outcome)
                .unwrap_or_default();
        }
    }
}
