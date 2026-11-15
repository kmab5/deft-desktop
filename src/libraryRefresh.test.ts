import { describe, expect, it } from 'vitest';
import { applyLibraryChanges } from './libraryRefresh';
import type { Book, Snapshot } from './types';

const book = (id: string, favorite = false) => ({ id, favorite }) as Book;

const snapshot: Snapshot = {
  books: [book('a'), book('b'), book('c')], authors: [], categories: [], types: [], annotations: [],
  readThroughs: [], sessions: [], folders: [], settings: { readerFontSize: 19 }, cacheBytes: 10,
};

describe('library refresh', () => {
  it('changes a single book without replacing the unaffected rows', () => {
    const result = applyLibraryChanges(snapshot, {
      revision: 5, cacheBytes: 10, changes: [{ rows: { books: { upsert: [book('b', true)], remove: [] } }, fields: {} }],
    });
    expect(result.books.map(row => row.id)).toEqual(['a', 'b', 'c']);
    expect(result.books[1].favorite).toBe(true);
    expect(result.books[0]).toBe(snapshot.books[0]);
    expect(result.categories).toBe(snapshot.categories);
    expect(snapshot.books[1].favorite).toBe(false);
  });

  it('applies ordered edits and deletions and can carry settings separately', () => {
    const result = applyLibraryChanges(snapshot, {
      revision: 7, cacheBytes: 0, changes: [
        { rows: { books: { upsert: [book('d')], remove: ['b'], order: ['d', 'a', 'c'] } }, fields: {} },
        { rows: {}, fields: { settings: { readerFontSize: 20 } } },
      ],
    });
    expect(result.books.map(row => row.id)).toEqual(['d', 'a', 'c']);
    expect(result.settings.readerFontSize).toBe(20);
    expect(result.cacheBytes).toBe(0);
  });
});
