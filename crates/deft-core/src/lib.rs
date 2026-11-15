// SPDX-License-Identifier: GPL-3.0-only
pub mod catalog;
pub mod exchange;
pub mod formats;
pub mod matching;
pub mod model;
pub mod scanner;
pub mod store;
pub mod tracking;
pub mod transfer;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
