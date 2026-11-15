import DOMPurify from 'dompurify';
import type { Annotation, Locator } from './types';

export interface Chapter {
  title: string;
  html: string;
  href?: string;
}

export interface TocEntry {
  title: string;
  chapter: number;
  href?: string;
}

export interface Publication {
  kind: 'text' | 'images' | 'pdf' | 'djvu' | 'mobi';
  chapters?: Chapter[];
  toc?: TocEntry[];
  pageCount?: number;
  language?: string;
}

export interface TextChapter extends Chapter {
  text: string;
  start: number;
  length: number;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

const POSITION_LENGTH = 1024;

const LOCAL_LINK = /^(?:#[^\s]*|deft-chapter:\d+(?:#[^\s]*)?)$/i;
const SAFE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
const TEXT_TAGS = [
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd',
  'del', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p', 'pre', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var',
  'math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'msub', 'msup', 'mfrac', 'msqrt',
];
const TEXT_ATTRIBUTES = [
  'alt', 'aria-label', 'colspan', 'dir', 'height', 'href', 'id', 'lang', 'name',
  'rowspan', 'scope', 'src', 'start', 'title', 'value', 'width',
];

export function prepareChapters(chapters: Chapter[]): TextChapter[] {
  let start = 0;
  return chapters.map(chapter => {
    const html = DOMPurify.sanitize(chapter.html, {
      ALLOWED_TAGS: TEXT_TAGS,
      ALLOWED_ATTR: TEXT_ATTRIBUTES,
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:#[^\s]*|deft-chapter:\d+(?:#[^\s]*)?|data:image\/)/i,
      FORBID_TAGS: ['iframe', 'object', 'embed', 'script', 'style', 'link', 'meta', 'template', 'svg'],
      SANITIZE_NAMED_PROPS: true,
      RETURN_DOM_FRAGMENT: true,
    });
    for (const node of html.querySelectorAll('img')) {
      if (!SAFE_IMAGE.test(node.getAttribute('src') || '')) {
        node.removeAttribute('src');
        if (!node.alt) node.remove();
      } else {
        node.decoding = 'async';
        node.loading = 'lazy';
      }
    }
    for (const anchor of html.querySelectorAll('a[href]')) {
      if (!LOCAL_LINK.test(anchor.getAttribute('href') || '')) anchor.removeAttribute('href');
    }
    const template = document.createElement('template');
    template.content.append(html);
    const text = template.content.textContent || '';
    const length = Math.max(1, text.length);
    const prepared = { ...chapter, html: template.innerHTML, text, start, length };
    start += length;
    return prepared;
  });
}

export function getLocator(chapters: TextChapter[], chapter: number, offset: number): Locator {
  const index = clamp(Math.trunc(chapter), 0, Math.max(0, chapters.length - 1));
  const current = chapters[index];
  const last = chapters.at(-1);
  const safeOffset = clamp(Math.trunc(offset), 0, current?.length ?? 0);
  const absolute = (current?.start ?? 0) + safeOffset;
  return {
    chapter: index,
    offset: safeOffset,
    progress: absolute / Math.max(1, (last?.start ?? 0) + (last?.length ?? 0)),
    position: Math.floor(absolute / POSITION_LENGTH),
    href: current?.href,
  };
}

/** Positions are stable across font and window changes in reflowable books. */
export function estimatedPage(chapters: TextChapter[], locator: Locator) {
  const last = chapters.at(-1);
  const total = Math.max(1, Math.ceil(((last?.start ?? 0) + (last?.length ?? 0)) / POSITION_LENGTH));
  return { current: clamp(locator.position + 1, 1, total), total };
}

export function locatorAtProgress(chapters: TextChapter[], progress: number): Locator {
  const last = chapters.at(-1);
  const absolute = Math.floor(clamp(progress, 0, 1) * ((last?.start ?? 0) + (last?.length ?? 0)));
  let lo = 0;
  let hi = chapters.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (chapters[mid].start <= absolute) lo = mid;
    else hi = mid - 1;
  }
  return getLocator(chapters, lo, absolute - (chapters[lo]?.start ?? 0));
}

export function restoreTextLocator(chapters: TextChapter[], locator?: Locator, fallback = 0): Locator {
  if (!locator) return locatorAtProgress(chapters, fallback);
  const index = locator.href
    ? chapters.findIndex(chapter => chapter.href === locator.href)
    : locator.chapter;
  if (index >= 0 && chapters[index] && locator.offset <= chapters[index].length) {
    return getLocator(chapters, index, locator.offset);
  }
  return locatorAtProgress(chapters, locator.progress);
}

export const pageLocator = (index: number, count: number): Locator => {
  const page = clamp(Math.trunc(index), 0, Math.max(0, count - 1));
  return { chapter: page, offset: 0, position: page, progress: count === 1 ? 1 : count < 1 ? 0 : page / (count - 1), page };
};

function boundary(root: HTMLElement, offset: number): [Node, number] {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let last: Node | null = null;
  let remaining = Math.max(0, offset);
  while ((node = walk.nextNode())) {
    last = node;
    const size = node.textContent?.length ?? 0;
    if (size > remaining) return [node, remaining];
    remaining -= size;
  }
  return last ? [last, last.textContent?.length ?? 0] : [root, 0];
}

export function rangeForOffsets(root: HTMLElement, from: number, to = from + 1): Range {
  const range = document.createRange();
  range.setStart(...boundary(root, from));
  range.setEnd(...boundary(root, Math.max(from, to)));
  return range;
}

export function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

export function anchorOffset(root: HTMLElement, fragment: string): number | undefined {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // A malformed URL fragment can still name a literal anchor.
  }
  const target = root.querySelector<HTMLElement>(
    `[id="${CSS.escape(`user-content-${id}`)}"], [name="${CSS.escape(`user-content-${id}`)}"]`,
  );
  if (!target) return undefined;
  return offsetIn(root, target, 0);
}

export function offsetAtPoint(root: HTMLElement, x: number, y: number): number | undefined {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (caret && root.contains(caret.startContainer)) {
    return offsetIn(root, caret.startContainer, caret.startOffset);
  }
  return undefined;
}

type HighlightConstructor = new (...ranges: Range[]) => object;
type HighlightRegistry = Map<string, object>;
const highlightCss = typeof CSS === 'undefined' ? undefined : CSS as typeof CSS & { highlights?: HighlightRegistry };

export const NOTE_COLORS = {
  purple: '#b65ff1',
  green: '#61bf94',
  amber: '#e4a957',
  gray: '#929199',
} as const;

export function paintHighlights(root: HTMLElement, notes: Annotation[]): void {
  const Highlight = (window as Window & { Highlight?: HighlightConstructor }).Highlight;
  if (!Highlight || !highlightCss?.highlights) return;
  clearHighlights();
  for (const color of Object.keys(NOTE_COLORS)) {
    const ranges = notes.filter(note => note.kind === 'highlight' && note.color === color)
      .flatMap(note => {
        const chapter = root.querySelector<HTMLElement>(`[data-chapter="${note.locator.chapter}"]`);
        return chapter && note.end !== undefined
          ? [rangeForOffsets(chapter, note.locator.offset, note.end)]
          : [];
      });
    if (ranges.length) highlightCss.highlights.set(`deft-${color}`, new Highlight(...ranges));
  }
}

export function clearHighlights(): void {
  for (const color of Object.keys(NOTE_COLORS)) highlightCss?.highlights?.delete(`deft-${color}`);
}

export type SearchHit = { locator: Locator; excerpt: string };

export function searchChapters(chapters: TextChapter[], query: string): SearchHit[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'giu');
  const hits: SearchHit[] = [];
  for (const [index, chapter] of chapters.entries()) {
    for (const match of chapter.text.matchAll(pattern)) {
      const offset = match.index;
      hits.push({
        locator: getLocator(chapters, index, offset),
        excerpt: chapter.text.slice(Math.max(0, offset - 45), offset + match[0].length + 60).replace(/\s+/g, ' ').trim(),
      });
      if (hits.length >= 250) return hits;
    }
  }
  return hits;
}
