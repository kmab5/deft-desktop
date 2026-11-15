// SPDX-License-Identifier: GPL-3.0-only
use crate::{
    catalog, id,
    model::{BookState, Locator, ReadThrough, Session, State},
};
use anyhow::{anyhow, ensure, Result};
use serde::Deserialize;

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Normal,
    Resume,
    Restart,
    Reread,
    Browse,
}

#[derive(Clone)]
pub struct Visit {
    pub session: Session,
    pub minimum_seconds: u64,
    pub prompted: bool,
    pub checkpoint_ms: u64,
    needs_run: bool,
    reopen_run: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub reading_id: String,
    pub locator: Locator,
    pub active_ms: u64,
    pub pages_turned: u64,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub zone_offset_minutes: i32,
    #[serde(default)]
    pub start_locator: Option<Locator>,
}

pub fn visit(state: &mut State, book_id: &str, mode: Mode, time: i64) -> Result<Visit> {
    let book = catalog::book(state, book_id)?;
    ensure!(!book.missing, "This file is missing. Its history is safe.");
    ensure!(
        !book.protected,
        "This file is DRM-protected. Deft cannot open it."
    );
    ensure!(
        !book.ignored,
        "Restore this book from ignored books to read it."
    );
    let latest = state
        .read_throughs
        .iter()
        .rev()
        .find(|run| run.book_id == book_id);
    let browse = matches!(mode, Mode::Browse);
    let reset = matches!(mode, Mode::Restart | Mode::Reread);
    let resume = matches!(mode, Mode::Resume);
    ensure!(
        book.state != BookState::Finished || browse || reset,
        "Choose whether to reread or browse this book."
    );
    ensure!(
        book.state != BookState::Abandoned || reset || resume,
        "Choose whether to resume or start over."
    );
    ensure!(
        !browse || latest.is_some(),
        "This book has no read-through to browse."
    );
    let first = reset || latest.is_none();
    let run_id = if first {
        id()
    } else {
        latest.expect("known read-through").id.clone()
    };
    let locator = if reset {
        Locator::default()
    } else {
        book.locator.clone().unwrap_or_default()
    };
    let previously_prompted = !first && latest.is_some_and(|run| run.prompted);
    let reopen = !first
        && !browse
        && latest
            .is_some_and(|run| matches!(run.outcome, BookState::Paused | BookState::Abandoned));
    let minimum_seconds = state.settings["minSessionSeconds"]
        .as_u64()
        .unwrap_or(60)
        .clamp(60, 600);
    let book = catalog::book_mut(state, book_id)?;
    book.last_opened_at = Some(time);
    if reset {
        book.locator = None;
        book.progress = 0.0;
    }
    let mut active = Visit {
        session: Session {
            id: id(),
            book_id: book_id.into(),
            read_through_id: run_id,
            started_at: time,
            ended_at: time,
            start_locator: locator.clone(),
            end_locator: locator,
            browsing: browse,
            ..Session::default()
        },
        minimum_seconds,
        prompted: previously_prompted,
        checkpoint_ms: 0,
        needs_run: first,
        reopen_run: reopen,
    };
    // An explicit reread or start-over is itself the request for a new read-through.
    if reset {
        active.register_run(state, 0);
    }
    Ok(active)
}

impl Visit {
    fn register_run(&mut self, state: &mut State, zone_offset_minutes: i32) {
        if self.needs_run {
            state.read_throughs.push(ReadThrough {
                id: self.session.read_through_id.clone(),
                book_id: self.session.book_id.clone(),
                started_at: self.session.started_at,
                outcome: BookState::Reading,
                prompted: self.prompted,
                zone_offset_minutes,
                ..ReadThrough::default()
            });
            self.needs_run = false;
        } else if self.reopen_run {
            if let Some(run) = state
                .read_throughs
                .iter_mut()
                .find(|run| run.id == self.session.read_through_id)
            {
                if matches!(run.outcome, BookState::Paused | BookState::Abandoned) {
                    run.outcome = BookState::Reading;
                    run.ended_at = None;
                }
            }
            self.reopen_run = false;
        }
        state.sync_book_state(&self.session.book_id);
    }

    pub fn update(&mut self, state: &mut State, input: Checkpoint, time: i64) -> Result<()> {
        ensure!(
            input.reading_id == self.session.id,
            "The reader has already closed."
        );
        if input.active_ms < self.checkpoint_ms {
            return Ok(());
        }
        let mut locator = input.locator;
        locator.progress = locator.progress.clamp(0.0, 1.0);
        if self.checkpoint_ms == 0 {
            if let Some(start) = input.start_locator {
                self.session.start_locator = start;
            }
        }
        let zone = input.zone_offset_minutes.clamp(-840, 840);
        let real_elapsed = time.saturating_sub(self.session.started_at).max(0) as u64;
        self.checkpoint_ms = input
            .active_ms
            .min(real_elapsed.saturating_add(1_000))
            .max(self.checkpoint_ms);
        self.session.active_seconds = self.checkpoint_ms / 1000;
        self.session.ended_at = time.max(self.session.started_at);
        self.session.end_locator = locator.clone();
        self.session.zone_offset_minutes = zone;
        self.session.pages_turned = self.session.pages_turned.max(input.pages_turned);
        if !self.session.browsing {
            let book = catalog::book_mut(state, &self.session.book_id)?;
            book.progress = locator.progress;
            book.locator = Some(locator);
        }
        if self.session.active_seconds >= self.minimum_seconds {
            self.register_run(state, zone);
            ensure!(
                state
                    .read_throughs
                    .iter()
                    .any(|run| run.id == self.session.read_through_id),
                "This read-through has been deleted."
            );
            if let Some(session) = state
                .sessions
                .iter_mut()
                .find(|session| session.id == self.session.id)
            {
                *session = self.session.clone();
            } else {
                state.sessions.push(self.session.clone());
            }
        }
        Ok(())
    }

    pub fn finish_prompt(&mut self, state: &mut State) -> bool {
        if self.session.browsing || self.prompted {
            return false;
        }
        let current = state
            .read_throughs
            .iter_mut()
            .rev()
            .find(|run| run.book_id == self.session.book_id);
        if let Some(run) = current {
            if run.id == self.session.read_through_id {
                if run.outcome == BookState::Finished || run.prompted {
                    return false;
                }
                run.prompted = true;
            }
        }
        self.prompted = true;
        true
    }
}

pub fn set_state(
    state: &mut State,
    book_id: &str,
    outcome: BookState,
    date: Option<i64>,
    zone_offset_minutes: i32,
    time: i64,
    visit: Option<&mut Visit>,
) -> Result<()> {
    catalog::book(state, book_id)?;
    ensure!(
        outcome != BookState::NotRead,
        "Delete the read-throughs to reset reading state."
    );
    let zone = zone_offset_minutes.clamp(-840, 840);
    if let Some(visit) = visit {
        if visit.session.book_id == book_id && !visit.session.browsing {
            visit.register_run(state, zone);
        }
    }
    let end = date.unwrap_or(time);
    ensure!(
        end >= 0 && end <= time.saturating_add(86_400_000),
        "Enter a valid finish date."
    );
    if let Some(run) = state
        .read_throughs
        .iter_mut()
        .rev()
        .find(|run| run.book_id == book_id)
    {
        run.outcome = outcome;
        run.ended_at = (outcome != BookState::Reading).then_some(end);
        if end < run.started_at && run.ended_at.is_some() {
            run.started_at = end;
        }
        run.zone_offset_minutes = zone;
    } else {
        state.read_throughs.push(ReadThrough {
            id: id(),
            book_id: book_id.into(),
            started_at: end.min(time),
            ended_at: (outcome != BookState::Reading).then_some(end),
            outcome,
            zone_offset_minutes: zone,
            ..ReadThrough::default()
        });
    }
    state.sync_book_state(book_id);
    Ok(())
}

pub fn edit_run(state: &mut State, run_id: &str, start: i64, end: Option<i64>) -> Result<()> {
    ensure!(
        start >= 0 && end.is_none_or(|end| end >= start),
        "Enter a valid date range."
    );
    let run = state
        .read_throughs
        .iter_mut()
        .find(|run| run.id == run_id)
        .ok_or_else(|| anyhow!("Read-through not found."))?;
    ensure!(
        run.outcome != BookState::Finished || end.is_some(),
        "A finished read-through needs a finish date."
    );
    run.started_at = start;
    run.ended_at = end;
    Ok(())
}

pub fn delete_run(state: &mut State, run_id: &str) -> Result<()> {
    let book_id = state
        .read_throughs
        .iter()
        .find(|run| run.id == run_id)
        .ok_or_else(|| anyhow!("Read-through not found."))?
        .book_id
        .clone();
    state.read_throughs.retain(|run| run.id != run_id);
    state
        .sessions
        .retain(|session| session.read_through_id != run_id);
    state.sync_book_state(&book_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Book;
    fn checkpoint(active: &Visit, time: u64) -> Checkpoint {
        Checkpoint {
            reading_id: active.session.id.clone(),
            locator: Locator {
                progress: 0.5,
                ..Locator::default()
            },
            active_ms: time,
            closed: false,
            pages_turned: 2,
            zone_offset_minutes: 180,
            start_locator: None,
        }
    }
    #[test]
    fn checkpoints_are_idempotent_and_subminute_visits_only_save_position() -> Result<()> {
        let mut data = State::default();
        data.books.push(Book {
            id: "book".into(),
            ..Book::default()
        });
        let mut active = visit(&mut data, "book", Mode::Normal, 0)?;
        active.update(&mut data, checkpoint(&active, 35_000), 40_000)?;
        assert!(data.sessions.is_empty());
        assert_eq!(data.books[0].state, BookState::NotRead);
        assert_eq!(data.books[0].progress, 0.5);
        for _ in 0..2 {
            active.update(&mut data, checkpoint(&active, 60_000), 61_000)?;
        }
        assert_eq!(data.sessions.len(), 1);
        assert_eq!(data.sessions[0].active_seconds, 60);
        assert_eq!(data.books[0].state, BookState::Reading);
        set_state(
            &mut data,
            "book",
            BookState::Finished,
            None,
            180,
            70_000,
            Some(&mut active),
        )?;
        let mut browsing = visit(&mut data, "book", Mode::Browse, 90_000)?;
        browsing.update(&mut data, checkpoint(&browsing, 60_000), 155_000)?;
        assert_eq!(data.read_throughs.len(), 1);
        assert!(data.sessions[1].browsing);
        assert_eq!(data.books[0].state, BookState::Finished);
        Ok(())
    }
}
