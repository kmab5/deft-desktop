import { nativeBookBytes } from './api';
import { clamp, pageLocator, type Publication, type SearchHit, type TocEntry } from './readerText';

export interface PageSource {
  count: number;
  toc(): Promise<TocEntry[]>;
  render(index: number, width: number, crop: boolean): Promise<Blob>;
  search?(query: string, signal: AbortSignal): Promise<SearchHit[]>;
  close(): void;
}

export type BinaryPublication = Exclude<Publication['kind'], 'text' | 'mobi'>;
type PasswordRequest = (submit: (password: string) => void, incorrect: boolean) => void;

export const publicationBytes = nativeBookBytes;

function imageType(bytes: Uint8Array): string {
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  const start = String.fromCharCode(...bytes.subarray(0, 16));
  if (start.startsWith('GIF87a') || start.startsWith('GIF89a')) return 'image/gif';
  if (start.startsWith('RIFF') && start.slice(8, 12) === 'WEBP') return 'image/webp';
  if (start.startsWith('BM')) return 'image/bmp';
  if (start.slice(4, 8) === 'ftyp' && /^(avif|avis)$/.test(start.slice(8, 12))) return 'image/avif';
  throw new Error('This comic page uses an unsupported image format.');
}

function comic(bookId: string, count: number, signal: AbortSignal): PageSource {
  return {
    count,
    toc: async () => [],
    async render(index) {
      const bytes = await publicationBytes(bookId, index, signal);
      return new Blob([bytes], { type: imageType(new Uint8Array(bytes)) });
    },
    close() {},
  };
}

function asBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('This page could not be drawn.'));
    }, 'image/png');
  });
}

function trimMargins(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const sample = document.createElement('canvas');
  const scale = Math.min(1, 350 / Math.max(canvas.width, canvas.height));
  sample.width = Math.max(1, Math.round(canvas.width * scale));
  sample.height = Math.max(1, Math.round(canvas.height * scale));
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return canvas;
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const { data, width, height } = context.getImageData(0, 0, sample.width, sample.height);
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 4;
      if (data[pixel + 3] < 32 || Math.min(data[pixel], data[pixel + 1], data[pixel + 2]) >= 220) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  if (x1 <= x0 || y1 <= y0) return canvas;
  const left = Math.max(0, Math.floor((x0 - 3) / scale));
  const top = Math.max(0, Math.floor((y0 - 3) / scale));
  const right = Math.min(canvas.width, Math.ceil((x1 + 3) / scale));
  const bottom = Math.min(canvas.height, Math.ceil((y1 + 3) / scale));
  if (right - left === canvas.width && bottom - top === canvas.height) return canvas;
  const cropped = document.createElement('canvas');
  cropped.width = right - left;
  cropped.height = bottom - top;
  cropped.getContext('2d')?.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return cropped;
}

async function pdf(bytes: ArrayBuffer, requestPassword: PasswordRequest, signal: AbortSignal): Promise<PageSource> {
  const [library, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  signal.throwIfAborted();
  library.GlobalWorkerOptions.workerSrc = worker.default;
  const support = new URL('/reader-support/', window.location.href).href;
  const task = library.getDocument({
    data: bytes,
    cMapUrl: `${support}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${support}standard_fonts/`,
    iccUrl: `${support}iccs/`,
    wasmUrl: `${support}wasm/`,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: false,
    docBaseUrl: undefined,
  });
  task.onPassword = (submit: (value: string) => void, reason: number) => {
    if (!signal.aborted) requestPassword(submit, reason === library.PasswordResponses.INCORRECT_PASSWORD);
  };
  const dispose = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const pdfDocument = await task.promise;
    return {
      count: pdfDocument.numPages,
      async toc() {
        const outline = await pdfDocument.getOutline();
        if (!outline) return [];
        const result: TocEntry[] = [];
        async function walk(items: NonNullable<typeof outline>, depth = 0) {
          for (const item of items) {
            const dest = typeof item.dest === 'string'
              ? await pdfDocument.getDestination(item.dest).catch(() => null)
              : item.dest;
            if (Array.isArray(dest) && dest.length) {
              const chapter = typeof dest[0] === 'number'
                ? dest[0] : await pdfDocument.getPageIndex(dest[0]).catch(() => -1);
              if (chapter >= 0) result.push({ chapter, title: `${'  '.repeat(depth)}${item.title}` });
            }
            if (item.items.length && depth < 12) await walk(item.items, depth + 1);
          }
        }
        await walk(outline);
        return result;
      },
      async render(index, width, crop) {
        const page = await pdfDocument.getPage(index + 1);
        const dimensions = page.getViewport({ scale: 1 });
        const scale = Math.min(6, width / dimensions.width, 4096 / Math.max(dimensions.width, dimensions.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        await page.render({ canvas, viewport, annotationMode: library.AnnotationMode.DISABLE }).promise;
        return await asBlob(crop ? trimMargins(canvas) : canvas);
      },
      async search(query, searchSignal) {
        const needle = query.toLocaleLowerCase();
        const hits: SearchHit[] = [];
        for (let page = 1; page <= pdfDocument.numPages && hits.length < 250; page++) {
          searchSignal.throwIfAborted();
          const content = await (await pdfDocument.getPage(page)).getTextContent();
          const source = content.items.map(item => 'str' in item ? item.str : '').join(' ');
          const index = source.toLocaleLowerCase().indexOf(needle);
          if (index < 0) continue;
          hits.push({
            locator: pageLocator(page - 1, pdfDocument.numPages),
            excerpt: source.slice(Math.max(0, index - 45), index + query.length + 60),
          });
        }
        return hits;
      },
      close() {
        signal.removeEventListener('abort', dispose);
        dispose();
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', dispose);
    if (!signal.aborted) dispose();
    throw error;
  }
}

type DjvuResult = { id: number; error?: string; count?: number; width?: number; height?: number; pixels?: Uint8ClampedArray<ArrayBuffer> };

async function djvu(bytes: ArrayBuffer, signal: AbortSignal): Promise<PageSource> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./readerDjvu.worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { resolve: (result: DjvuResult) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let closed = false;
  function disconnect(error: Error) {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const request of waiting.values()) request.reject(error);
    waiting.clear();
  }
  const close = () => {
    signal.removeEventListener('abort', close);
    disconnect(new DOMException('The document was closed.', 'AbortError'));
  };
  signal.addEventListener('abort', close, { once: true });
  worker.onerror = event => disconnect(new Error(event.message || 'The DjVu renderer failed.'));
  worker.onmessage = ({ data }: MessageEvent<DjvuResult>) => {
    const request = waiting.get(data.id);
    if (!request) return;
    waiting.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data);
  };

  function send(payload: object, transfer: Transferable[] = []): Promise<DjvuResult> {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('The DjVu document is closed.'));
      const id = ++sequence;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id }, transfer);
    });
  }

  try {
    const { count = 0 } = await send({ action: 'open', bytes }, [bytes]);
    if (!count) throw new Error('There are no pages in this DjVu document.');
    return {
      count,
      toc: async () => [],
      async render(index, width, crop) {
        const result = await send({ action: 'render', page: index, width });
        if (!result.width || !result.height || !result.pixels) throw new Error('The DjVu page is empty.');
        const canvas = document.createElement('canvas');
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext('2d')?.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
        return await asBlob(crop ? trimMargins(canvas) : canvas);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export async function openPages(
  bookId: string,
  publication: Publication,
  signal: AbortSignal,
  password: PasswordRequest,
): Promise<PageSource> {
  if (publication.kind === 'images') {
    const count = clamp(publication.pageCount ?? 0, 0, 100_000);
    if (!count) throw new Error('There are no image pages in this comic.');
    return comic(bookId, count, signal);
  }
  const bytes = await publicationBytes(bookId, undefined, signal);
  return publication.kind === 'pdf' ? pdf(bytes, password, signal) : djvu(bytes, signal);
}
