// SPDX-License-Identifier: GPL-3.0-only
use anyhow::{anyhow, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const CHUNK: usize = 192 * 1024;
const IN_FLIGHT: usize = 768 * 1024 * 1024;
const STALE: Duration = Duration::from_secs(90);

struct Transfer {
    bytes: Vec<u8>,
    touched: Instant,
}

#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, Transfer>>);

impl Transfers {
    pub fn json(&self, value: Value) -> Result<Value> {
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() <= CHUNK {
            return Ok(value);
        }
        self.put(bytes)
    }

    pub fn put(&self, bytes: Vec<u8>) -> Result<Value> {
        if bytes.len() <= CHUNK {
            return Ok(json!({"deftBytes": STANDARD.encode(bytes)}));
        }

        let id = crate::id();
        let chunks = bytes.len().div_ceil(CHUNK);
        let size = bytes.len();
        let mut entries = self
            .0
            .lock()
            .map_err(|_| anyhow!("Transfer unavailable."))?;
        entries.retain(|_, entry| entry.touched.elapsed() < STALE);
        let occupied = entries
            .values()
            .map(|entry| entry.bytes.len())
            .sum::<usize>();
        ensure!(
            size.saturating_add(occupied) <= IN_FLIGHT,
            "Deft is already transferring a large file. Try again shortly."
        );
        entries.insert(
            id.clone(),
            Transfer {
                bytes,
                touched: Instant::now(),
            },
        );
        Ok(json!({"deftTransfer": {"id": id, "chunks": chunks, "size": size}}))
    }

    pub fn chunk(&self, id: &str, index: usize) -> Result<String> {
        let mut entries = self
            .0
            .lock()
            .map_err(|_| anyhow!("Transfer unavailable."))?;
        entries.retain(|_, entry| entry.touched.elapsed() < STALE);
        let transfer = entries
            .get_mut(id)
            .ok_or_else(|| anyhow!("The transfer expired. Open the book again."))?;
        let start = index
            .checked_mul(CHUNK)
            .filter(|start| *start < transfer.bytes.len())
            .ok_or_else(|| anyhow!("Invalid transfer offset."))?;
        transfer.touched = Instant::now();
        let end = (start + CHUNK).min(transfer.bytes.len());
        let chunk = STANDARD.encode(&transfer.bytes[start..end]);
        if end == transfer.bytes.len() {
            entries.remove(id);
        }
        Ok(chunk)
    }

    pub fn discard(&self, id: &str) {
        if let Ok(mut entries) = self.0.lock() {
            entries.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_large_payloads_and_releases_them() -> Result<()> {
        let transfers = Transfers::default();
        let bytes: Vec<_> = (0..CHUNK * 2 + 37).map(|i| (i % 251) as u8).collect();
        let descriptor = transfers.put(bytes.clone())?;
        let id = descriptor["deftTransfer"]["id"].as_str().unwrap();
        assert_eq!(descriptor["deftTransfer"]["size"], bytes.len());
        assert_eq!(descriptor["deftTransfer"]["chunks"], 3);
        let mut received = Vec::new();
        for index in 0..3 {
            received.extend(STANDARD.decode(transfers.chunk(id, index)?)?);
        }
        assert_eq!(received, bytes);
        assert!(transfers.chunk(id, 0).is_err());
        Ok(())
    }
}
