import { describe, expect, it } from 'vitest';
import { getLocator, locatorAtProgress, pageLocator, restoreTextLocator, searchChapters, type TextChapter } from './readerText';

const chapters: TextChapter[] = [
  { title: 'one', href: 'one.xhtml', html: '', text: 'Lorem ipsum? A [dot.] belongs here.', length: 35, start: 0 },
  { title: 'two', href: 'two.xhtml', html: '', text: 'Much more reading. '.repeat(130), length: 2470, start: 35 },
];

describe('reader locators', () => {
  it('round-trips Unicode character offsets and normalizes book progress', () => {
    const point = getLocator(chapters, 1, 1092);
    expect(point).toMatchObject({ chapter: 1, position: 1, href: 'two.xhtml' });
    const restored = locatorAtProgress(chapters, point.progress);
    expect(restored.chapter).toBe(point.chapter);
    expect(Math.abs(restored.offset - point.offset)).toBeLessThanOrEqual(1);
    expect(locatorAtProgress(chapters, 1)).toMatchObject({ chapter: 1, offset: 2470, progress: 1 });
  });

  it('resolves a reordered chapter by resource and falls back for a removed one', () => {
    const point = getLocator(chapters, 1, 100);
    expect(restoreTextLocator(chapters, { ...point, chapter: 0 })).toEqual(point);
    expect(restoreTextLocator(chapters, { ...point, href: 'former.xhtml' })).toEqual(locatorAtProgress(chapters, point.progress));
  });

  it('keeps page numbers zero-based and counts a one-page document as complete', () => {
    expect(pageLocator(9, 4)).toEqual({ page: 3, chapter: 3, offset: 0, progress: 1, position: 3 });
    expect(pageLocator(0, 1).progress).toBe(1);
  });
});

describe('in-book search', () => {
  it('treats punctuation as text and matches case-insensitively', () => {
    const hits = searchChapters(chapters, '[DOT.]');
    expect(hits).toHaveLength(1);
    expect(hits[0].locator.chapter).toBe(0);
    expect(hits[0].excerpt).toContain('[dot.]');
    expect(searchChapters(chapters, '.*?').length).toBe(0);
  });
});
