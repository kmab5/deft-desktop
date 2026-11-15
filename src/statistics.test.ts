import { describe, expect, it } from 'vitest';
import type { Book, Locator, ReadThrough, Session, Snapshot } from './types';
import { periodFor, summarizeBook, summarizeBooks, summarizePeriod, yearlyPace } from './statistics';

function book(id: string, overrides: Partial<Book> = {}): Book {
  return {
    id, title: id, authors: ['Mira Chen', 'N. Flores'], authorIds: [], format: 'epub',
    metadata: { title: id, authors: [], protected: false, pageCount: 300 },
    files: [], addedAt: 0, ignored: false, missing: false, review: '', favorite: false,
    progress: 0.5, state: 'reading', protected: false, ...overrides,
  };
}

function locator(position: number): Locator {
  return { chapter: 0, offset: position, position, progress: position / 300 };
}

function session(id: string, bookId: string, overrides: Partial<Session> = {}): Session {
  const startedAt = Date.UTC(2026, 0, 1, 21, 59);
  return {
    id, bookId, readThroughId: 'attempt', startedAt, endedAt: startedAt + 240_000,
    activeSeconds: 240, zoneOffsetMinutes: 120, browsing: false,
    pagesTurned: 3, startLocator: locator(0), endLocator: locator(8), ...overrides,
  };
}

function attempt(id: string, bookId: string, overrides: Partial<ReadThrough> = {}): ReadThrough {
  return {
    id, bookId, startedAt: Date.UTC(2026, 0, 1, 21, 59), endedAt: Date.UTC(2026, 0, 1, 22, 1),
    outcome: 'finished', zoneOffsetMinutes: 120, ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    books: [], authors: [], categories: [], types: [], annotations: [], readThroughs: [],
    sessions: [], folders: [], settings: {}, ...overrides,
  };
}

describe('reading statistics', () => {
  it('attributes a midnight-spanning session and the completed read-through to local dates', () => {
    const data = snapshot({
      books: [book('book')],
      sessions: [session('normal', 'book')],
      readThroughs: [attempt('attempt', 'book')],
    });
    const first = summarizePeriod(data, { start: '2026-01-01', end: '2026-01-01' }, 'custom', '2026-01-02');
    expect(first).toMatchObject({ activeSeconds: 60, finished: 0, pages: 2, currentStreak: 1 });
    const second = summarizePeriod(data, { start: '2026-01-02', end: '2026-01-02' }, 'custom', '2026-01-02');
    expect(second).toMatchObject({ activeSeconds: 180, finished: 1, pages: 6, currentStreak: 2, longestStreak: 1 });
    expect(second.times.at(0)?.value).toBe(180);
    expect(second.topAuthor).toMatchObject({ value: 180 });
    expect(second.records).toMatchObject({ longestBook: 300, longestDay: 180, mostBooksInMonth: 1 });
  });

  it('credits every author, excludes browsing and ignored books and retains missing books', () => {
    const data = snapshot({
      books: [
        book('missing', { missing: true, rating: 4.5, state: 'finished' }),
        book('ignored', { ignored: true, rating: 1 }),
        book('abandoned', { rating: 3, state: 'abandoned' }),
      ],
      sessions: [
        session('counted', 'missing'), session('rereview', 'missing', { browsing: true }),
        session('hidden', 'ignored'),
      ],
      readThroughs: [
        attempt('a', 'missing'), attempt('b', 'ignored'),
        attempt('c', 'abandoned', { outcome: 'abandoned' }),
      ],
    });
    const whole = summarizePeriod(data, periodFor('all'), 'all', '2026-01-02');
    expect(whole).toMatchObject({ activeSeconds: 240, finished: 1, abandoned: 1, abandonRate: 0.5, pages: 8, pagesPerHour: 120 });
    expect(whole.topRated.map(value => value.id)).toEqual(['missing']);
    expect(whole.topAuthor?.value).toBe(240);
    expect(summarizeBook(data, 'missing')).toMatchObject({ activeSeconds: 240, sessions: 1, averageSeconds: 240, pages: 8 });
    expect(summarizeBook(data, 'abandoned').estimateSeconds).toBe(4500);
    expect(summarizeBooks(data, ['missing', 'ignored', 'abandoned']))
      .toMatchObject({ total: 2, finished: 1, abandoned: 1, activeSeconds: 240, rating: 3.75 });
  });

  it('honors each captured zone, a configured streak threshold, and leap-day goal pace', () => {
    const east = session('east', 'book', { startedAt: Date.UTC(2024, 1, 28, 23, 1), endedAt: Date.UTC(2024, 1, 28, 23, 3), activeSeconds: 120, zoneOffsetMinutes: 120 });
    const west = session('west', 'book', { startedAt: Date.UTC(2024, 2, 2, 0, 1), endedAt: Date.UTC(2024, 2, 2, 0, 3), activeSeconds: 120, zoneOffsetMinutes: -120 });
    const data = snapshot({ books: [book('book')], sessions: [east, west], settings: { streakMinutes: 2 } });
    const summary = summarizePeriod(data, periodFor('year', '2024-03-02'), 'year', '2024-03-02');
    expect([...summary.calendar.keys()]).toEqual(['2024-02-29', '2024-03-01']);
    expect(summary).toMatchObject({ currentStreak: 2, longestStreak: 2 });
    expect(yearlyPace(2024, 366, 55, '2024-02-29')).toBe(-5);
    expect(periodFor('month', '2024-02-19').end).toBe('2024-02-29');
  });
});
