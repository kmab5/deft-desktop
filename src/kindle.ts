import { unzlibSync } from 'fflate';
import { MOBI, type KindlePublication, type KindleToc } from 'foliate-js/mobi.js';
import type { Publication, TocEntry } from './readerText';

const CHAPTER_LIMIT = 12_000;
const IMAGE_LIMIT = 24 * 1024 * 1024;
const BOOK_LIMIT = 384 * 1024 * 1024;
const RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i;

interface ReadableSection {
  originalIndex: number;
  template: HTMLTemplateElement;
}

function localBlob(url: string): boolean {
  // The parser creates object URLs from embedded resources. Restrict reads to this origin and scheme.
  try {
    const uri = new URL(url);
    return uri.protocol === 'blob:' && uri.origin === location.origin;
  } catch {
    return false;
  }
}

function rasterType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  const header = String.fromCharCode(...bytes.subarray(0, 16));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  if (header.startsWith('BM')) return 'image/bmp';
  if (header.slice(4, 8) === 'ftyp' && /^(avif|avis)$/.test(header.slice(8, 12))) return 'image/avif';
  return undefined;
}

async function embeddedImage(url: string): Promise<string | undefined> {
  if (url.length <= IMAGE_LIMIT * 2 && RASTER_DATA.test(url)) return url;
  if (!localBlob(url)) return undefined;
  const response = await fetch(url);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > IMAGE_LIMIT) return undefined;
  const type = rasterType(new Uint8Array(bytes));
  if (!type) return undefined;
  return new Promise((resolve, reject) => {
    const file = new FileReader();
    file.onload = () => resolve(typeof file.result === 'string' ? file.result : undefined);
    file.onerror = () => reject(file.error ?? new Error('An illustration could not be read.'));
    file.readAsDataURL(new Blob([bytes], { type }));
  });
}

async function sectionDocument(load: () => Promise<string>): Promise<HTMLTemplateElement> {
  const url = await load();
  if (!localBlob(url)) throw new Error('The Kindle converter returned an invalid local chapter.');
  const source = await (await fetch(url)).text();
  if (source.length > BOOK_LIMIT) throw new Error('This Kindle chapter is too large to display.');
  const template = document.createElement('template');
  // Parsing into inert template content prevents the book from loading its own external resources.
  template.innerHTML = source;
  for (const node of template.content.querySelectorAll('style, link, script, meta, base, title, iframe, object, embed, video, audio, source')) node.remove();
  return template;
}

const label = (text: string | null | undefined) => text?.replace(/\s+/g, ' ').trim() || '';

async function kindleTarget(
  book: KindlePublication,
  href: string,
  sections: ReadableSection[],
  indices: Map<number, number>,
  createAnchor: () => string,
): Promise<TocEntry | undefined> {
  if (!/^(?:filepos:\d+|kindle:pos:fid:[a-v0-9]+:off:[a-v0-9]+)$/i.test(href)) return undefined;
  try {
    const location = await book.resolveHref(href);
    if (!location) return undefined;
    const chapter = indices.get(location.index);
    if (chapter === undefined) return undefined;
    let fragment = '';
    try {
      const target = location.anchor?.(sections[chapter].template.content);
      if (target) {
        const id = target.getAttribute('id') || target.getAttribute('name') || createAnchor();
        if (!target.hasAttribute('id') && !target.hasAttribute('name')) target.setAttribute('id', id);
        fragment = `#${encodeURIComponent(id)}`;
      }
    } catch {
      // A missing or damaged anchor still opens the right chapter.
    }
    return { title: '', chapter, href: `deft-chapter:${chapter}${fragment}` };
  } catch {
    return undefined;
  }
}

async function rewriteImages(template: HTMLTemplateElement, images: Map<string, Promise<string | undefined>>) {
  const load = (url: string) => {
    const cached = images.get(url);
    if (cached) return cached;
    const promise = embeddedImage(url).catch(() => undefined);
    images.set(url, promise);
    return promise;
  };
  for (const wrapper of template.content.querySelectorAll('svg')) {
    const raster = wrapper.querySelector('image');
    const href = raster?.getAttribute('href') || raster?.getAttribute('xlink:href') || '';
    if (!href) continue;
    const replacement = template.content.ownerDocument.createElement('img');
    const data = await load(href);
    if (data) replacement.setAttribute('src', data);
    replacement.setAttribute('alt', raster?.getAttribute('alt') || '');
    wrapper.replaceWith(replacement);
  }
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    image.removeAttribute('src');
    image.removeAttribute('srcset');
    if (!source) continue;
    const data = await load(source);
    if (data) image.setAttribute('src', data);
  }
}

function flatten(entries: KindleToc[]): KindleToc[] {
  const pending = [...entries].reverse();
  const results: KindleToc[] = [];
  while (pending.length && results.length < CHAPTER_LIMIT) {
    const entry = pending.pop();
    if (!entry) continue;
    results.push(entry);
    for (const child of (entry.subitems ?? []).slice().reverse()) pending.push(child);
  }
  return results;
}

export async function openKindle(bytes: ArrayBuffer): Promise<Publication> {
  // The native reader checks DRM before making the local bytes available.
  const parser = new MOBI({ unzlib: (data: Uint8Array) => unzlibSync(data) });
  const book: KindlePublication = await parser.open(new Blob([bytes]));
  try {
    if (book.sections.length > CHAPTER_LIMIT) throw new Error('This Kindle book has too many sections.');
    const sections: ReadableSection[] = [];
    let decodedSize = 0;
    for (const [originalIndex, section] of book.sections.entries()) {
      if (!section.load) continue;
      const template = await sectionDocument(section.load);
      decodedSize += template.innerHTML.length;
      if (decodedSize > BOOK_LIMIT) throw new Error('This Kindle book is too large to display.');
      sections.push({ originalIndex, template });
    }
    if (!sections.length) throw new Error('No readable chapters were found in this Kindle book.');
    const indices = new Map(sections.map(({ originalIndex }, chapter) => [originalIndex, chapter]));
    const images = new Map<string, Promise<string | undefined>>();
    const chapters = [];
    let anchor = 0;
    const createAnchor = () => `deft-kindle-anchor-${++anchor}`;
    const target = (href: string) => kindleTarget(book, href, sections, indices, createAnchor);
    const toc: TocEntry[] = [];
    for (const entry of flatten(book.toc ?? [])) {
      const destination = await target(entry.href);
      if (destination) toc.push({ ...destination, title: label(entry.label) || `chapter ${destination.chapter + 1}` });
    }
    const titles = new Map(toc.map(({ chapter, title }) => [chapter, title]));
    for (const { template } of sections) {
      for (const link of template.content.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href') ?? '';
        if (href.startsWith('#')) continue;
        link.removeAttribute('href');
        const destination = await target(href);
        if (destination?.href) link.setAttribute('href', destination.href);
      }
    }
    decodedSize = 0;
    for (const [index, { template }] of sections.entries()) {
      await rewriteImages(template, images);
      const html = template.innerHTML;
      decodedSize += html.length;
      if (decodedSize > BOOK_LIMIT) throw new Error('This Kindle book is too large to display.');
      const heading = template.content.querySelector('h1, h2, h3')?.textContent;
      const title = titles.get(index) || label(heading) || (sections.length === 1 ? book.metadata.title : undefined) || `chapter ${index + 1}`;
      chapters.push({ title, html, href: `deft-chapter:${index}` });
    }
    const language = Array.isArray(book.metadata.language) ? book.metadata.language[0] : book.metadata.language;
    return { kind: 'text', chapters, toc: toc.length ? toc : chapters.map(({ title, href }, chapter) => ({ title, chapter, href })), language };
  } finally {
    book.destroy();
  }
}
