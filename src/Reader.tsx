import { invoke } from '@tauri-apps/api/core';
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type FormEvent, type MouseEvent, type PointerEvent, type ReactNode, type TouchEvent,
} from 'react';
import {
  ArrowLeft, ArrowRight, Bookmark, BookOpen, BookText, Check, ChevronLeft, ChevronRight,
  CircleHelp, Clipboard, Fullscreen, Heart, List, LoaderCircle, Minus, NotebookPen,
  PanelTop, Plus, Search, Share2, SlidersHorizontal, X,
} from 'lucide-react';
import { describeError, rpc } from './api';
import { openKindle } from './kindle';
import { openPages, publicationBytes, type PageSource } from './readerPages';
import {
  anchorOffset, clamp, clearHighlights, getLocator, locatorAtProgress, NOTE_COLORS,
  offsetAtPoint, offsetIn, pageLocator, paintHighlights, prepareChapters, rangeForOffsets,
  restoreTextLocator, searchChapters, type Publication, type SearchHit, type TextChapter, type TocEntry,
} from './readerText';
import { useReaderTracking } from './readerTracking';
import { ReaderPreferences, READER_THEMES } from './Settings';
import type { Annotation, Book, Locator, ReadingMode, Settings } from './types';
import './reader.css';

export interface ReaderProps {
  book: Book;
  mode: ReadingMode;
  jump?: Locator;
  estimateSeconds?: number;
  settings: Settings;
  annotations: Annotation[];
  close: () => void | Promise<void>;
  updateSettings: (patch: Partial<Settings>) => void | Promise<void>;
  refresh: () => void | Promise<void>;
  notice: (message: string) => void;
}

interface OpenedBook {
  chapters: TextChapter[];
  pages?: PageSource;
  toc: TocEntry[];
  language?: string;
}
type ReadingPanel = 'contents' | 'search' | 'bookmarks' | 'settings' | null;
type AnnotationDraft = Pick<Annotation, 'kind' | 'locator' | 'text' | 'note' | 'color' | 'end'> & { id?: string };
type SelectionDraft = Pick<AnnotationDraft, 'locator' | 'text' | 'end'>;
type Jump = { locator: Locator; fragment?: string; lastColumn?: boolean; deliberate?: boolean; turn?: boolean };
type Theme = { id?: string; background: string; text: string; accent: string };
type ViewSize = { width: number; height: number };

const EMPTY_LOCATOR: Locator = { chapter: 0, offset: 0, progress: 0, position: 0 };
const LIGHT_FALLBACK: Theme = { background: '#fbf9f4', text: '#1b1b1f', accent: '#7d34b2' };
const percent = (progress: number) => Math.round(clamp(progress, 0, 1) * 100);
const isPdfOrDjvu = (book: Book) => ['pdf', 'djvu'].includes(book.format);

function ReaderButton({ label, children, onClick, pressed, disabled }: {
  label: string; children: ReactNode; onClick: () => void; pressed?: boolean; disabled?: boolean;
}) {
  return <button type="button" className="reader-icon" title={label} aria-label={label}
    aria-pressed={pressed} onClick={onClick} disabled={disabled}>{children}</button>;
}

function ReaderDialog({ title, children, dismiss }: { title: string; children: ReactNode; dismiss?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return <dialog ref={dialog} className="reader-dialog" aria-label={title}
    onCancel={event => { event.preventDefault(); dismiss?.(); }}>
    <div className="reader-dialog-head">
      <h2>{title}</h2>
      {dismiss && <ReaderButton label="close dialog" onClick={dismiss}><X size={18} /></ReaderButton>}
    </div>
    {children}
  </dialog>;
}

const BookChapter = memo(function BookChapter({ chapter, index }: { chapter: TextChapter; index: number }) {
  return <article className="reader-chapter" data-chapter={index} aria-label={chapter.title}
    dangerouslySetInnerHTML={{ __html: chapter.html }} />;
});

const FixedPage = memo(function FixedPage({ source, page, display, viewport, fit, zoom, crop, invert, continuous, onReady }:
{
  source: PageSource;
  page: number;
  display: boolean;
  viewport: ViewSize;
  fit: string;
  zoom: number;
  crop: boolean;
  invert: boolean;
  continuous: boolean;
  onReady: (index: number) => void;
}) {
  const [result, setResult] = useState<{ url: string; width: number; height: number }>();
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pixelWidth = Math.round(clamp(viewport.width * zoom * Math.min(2, window.devicePixelRatio || 1), 700, 3000) / 200) * 200;
  useEffect(() => {
    if (!display) return;
    const id = ++generation.current;
    let url: string | undefined;
    setError('');
    source.render(page, pixelWidth, crop).then(blob => {
      if (id !== generation.current) return;
      url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        if (id !== generation.current || !url) return;
        setResult({ url, width: image.naturalWidth, height: image.naturalHeight });
        onReady(page);
      };
      image.onerror = () => {
        if (id === generation.current) setError('This page could not be decoded.');
      };
      image.src = url;
    }).catch(reason => {
      if (id === generation.current) setError(describeError(reason));
    });
    return () => {
      generation.current++;
      if (url) URL.revokeObjectURL(url);
      setResult(undefined);
    };
  }, [display, source, page, pixelWidth, crop, onReady]);

  const availableWidth = Math.max(viewport.width - 32, 1);
  const availableHeight = Math.max(viewport.height - 40, 1);
  const ratio = result ? result.width / result.height : 0.707;
  const baseWidth = fit === 'width' ? availableWidth : fit === 'height'
    ? availableHeight * ratio : Math.min(availableWidth, availableHeight * ratio);
  const imageWidth = Math.max(1, baseWidth * zoom);
  const frameHeight = continuous ? Math.max(100, imageWidth / ratio + 36) : Math.max(viewport.height, imageWidth / ratio + 36);
  return <section className="reader-frame" data-fixed-page={page} aria-label={`page ${page + 1}`}
    style={{ minHeight: frameHeight, minWidth: imageWidth + 24 }}>
    {display && (error
      ? <div className="reader-page-error" role="alert"><CircleHelp />{error}</div>
      : result
        ? <img alt={`page ${page + 1}`} src={result.url} width={imageWidth}
          className={invert ? 'reader-page-inverted' : undefined} draggable={false} />
        : <div className="reader-page-error" role="status"><LoaderCircle className="reader-spin" size={22} /> drawing page</div>)}
  </section>;
});

export function Reader({ book, mode, jump, estimateSeconds, settings, annotations, close, updateSettings, refresh, notice }: ReaderProps) {
  const [opened, setOpened] = useState<OpenedBook>();
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState<{ submit: (value: string) => void; incorrect: boolean }>();
  const [passwordText, setPasswordText] = useState('');
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState<Locator>(() => jump ?? book.locator ?? EMPTY_LOCATOR);
  const [panel, setPanel] = useState<ReadingPanel>(null);
  const [chrome, setChrome] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [preferences, setPreferences] = useState<Record<string, unknown>>(book.fixed ?? {});
  const [temporarySettings, setTemporarySettings] = useState<Partial<Settings>>({});
  const currentSettings = { ...settings, ...temporarySettings };
  const [selection, setSelection] = useState<SelectionDraft>();
  const [draft, setDraft] = useState<AnnotationDraft>();
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [viewportSize, setViewportSize] = useState<ViewSize>({ width: 1000, height: 700 });
  const [skipBack, setSkipBack] = useState<Locator>();
  const [finish, setFinish] = useState<'ask' | 'rate' | null>(null);
  const [rating, setRating] = useState('');
  const [favorite, setFavorite] = useState(book.favorite);
  const [busy, setBusy] = useState(false);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [statusTime, setStatusTime] = useState(() => new Date());
  const [battery, setBattery] = useState<number>();
  const viewport = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const initialBook = useRef({ book, mode, jump });
  const location = useRef(cursor);
  const pending = useRef<Jump | null>(null);
  const suppressScrollUntil = useRef(0);
  const cadence = useRef(0);
  const canEnd = useRef(false);
  const once = useRef(false);
  const closeRequested = useRef(false);
  const panned = useRef(false);
  const scrollEvent = useRef(0);
  const lastPagedTurn = useRef(0);
  const lastSelection = useRef<SelectionDraft | undefined>(undefined);
  const pointerStart = useRef<{ x: number; y: number; left: number; top: number; panning: boolean } | null>(null);
  const touchStart = useRef<{ x: number; y: number; distance: number; zoom: number } | undefined>(undefined);
  const openedId = book.id;

  const isFixed = Boolean(opened?.pages);
  const chapters = opened?.chapters;
  const count = opened?.pages?.count ?? chapters?.length ?? 0;
  const chapter = chapters?.[cursor.chapter];
  const layout = isFixed ? (preferences.layout ?? currentSettings.readerLayout ?? 'paged') : (currentSettings.readerLayout ?? 'paged');
  const scrolling = layout === 'scroll';
  const zoom = clamp(Number(preferences.zoom ?? 1), 0.5, 4);
  const rtl = book.format === 'cbz' && Boolean(preferences.rtl);
  const crop = isPdfOrDjvu(book) && Boolean(preferences.crop);
  const invert = Boolean(preferences.invert ?? currentSettings.readerFixedInvert ?? false);
  const fit = String(preferences.fit ?? currentSettings.readerFixedFit ?? 'page');
  const tracking = useReaderTracking({
    bookId: openedId, mode, locator: cursor, enabled: ready,
    idleMinutes: Number(isFixed
      ? currentSettings.fixedIdleMinutes ?? currentSettings.idleFixed ?? 10
      : currentSettings.reflowIdleMinutes ?? currentSettings.idleReflow ?? 5),
    keepAwake: currentSettings.readerKeepAwake !== false,
    notice,
  });
  const bookNotes = useMemo(() => annotations.filter(note => note.bookId === openedId), [annotations, openedId]);
  const bookmark = bookNotes.find(note => note.kind === 'bookmark' && note.locator.chapter === cursor.chapter &&
    (isFixed || Math.abs(note.locator.offset - cursor.offset) < 110));
  const pageNote = isFixed ? bookNotes.find(note => note.kind === 'page' && note.locator.chapter === cursor.chapter) : undefined;

  useEffect(() => {
    const request = new AbortController();
    let pageSource: PageSource | undefined;
    const { book: original, jump: destination, mode: entryMode } = initialBook.current;
    async function load() {
      try {
        let publication = await rpc<Publication>('open', { bookId: openedId });
        request.signal.throwIfAborted();
        if (publication.kind === 'mobi') {
          publication = await openKindle(await publicationBytes(openedId));
          request.signal.throwIfAborted();
          void invoke('publication_cache', { bookId: openedId, publication }).catch(() => {});
        }
        request.signal.throwIfAborted();
        const restart = entryMode === 'restart' || entryMode === 'reread';
        const saved = destination ?? (restart ? undefined : original.locator);
        const fallback = restart ? 0 : original.progress;
        if (publication.kind === 'text') {
          const parsed = prepareChapters(publication.chapters ?? []);
          if (!parsed.length) throw new Error('This book has no readable chapters.');
          const locator = restoreTextLocator(parsed, saved, fallback);
          pending.current = { locator };
          location.current = locator;
          setCursor(locator);
          setOpened({ chapters: parsed, toc: publication.toc?.length ? publication.toc : parsed.map((entry, index) =>
            ({ chapter: index, title: entry.title || `chapter ${index + 1}` })), language: publication.language });
          setReady(true);
        } else {
          const pages = await openPages(openedId, publication, request.signal, (submit, incorrect) => {
            setPassword({ submit, incorrect });
            setPasswordText('');
          });
          pageSource = pages;
          if (request.signal.aborted) {
            pages.close();
            return;
          }
          const locator = pageLocator(saved?.page ?? saved?.chapter ?? Math.round(fallback * (pages.count - 1)), pages.count);
          pending.current = { locator };
          location.current = locator;
          setPassword(undefined);
          setCursor(locator);
          setOpened({ pages, chapters: [], toc: publication.toc ?? [] });
          void pages.toc().then(toc => {
            if (!request.signal.aborted && toc.length) setOpened(previous => previous ? { ...previous, toc } : previous);
          }).catch(() => {});
        }
      } catch (error) {
        if (!request.signal.aborted) {
          setLoadError(describeError(error));
          setPassword(undefined);
        }
      }
    }
    void load();
    return () => {
      request.abort();
      pageSource?.close();
    };
  }, [openedId]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (!currentSettings.readerStatusLine) return;
    const ticker = window.setInterval(() => setStatusTime(new Date()), 30_000);
    type Battery = EventTarget & { level: number };
    let nativeBattery: Battery | undefined;
    let stopped = false;
    const update = () => setBattery(nativeBattery ? Math.round(nativeBattery.level * 100) : undefined);
    (navigator as Navigator & { getBattery?: () => Promise<Battery> }).getBattery?.().then(value => {
      if (stopped) return;
      nativeBattery = value;
      value.addEventListener('levelchange', update);
      update();
    }).catch(() => {});
    return () => {
      stopped = true;
      window.clearInterval(ticker);
      nativeBattery?.removeEventListener('levelchange', update);
    };
  }, [currentSettings.readerStatusLine]);

  useEffect(() => {
    const imported = (currentSettings.importedFonts ?? []).find((font: { name: string; data?: string }) =>
      font.name === currentSettings.readerFont);
    if (!imported?.data || !/^data:(?:font\/(?:ttf|otf|woff2?)|application\/(?:octet-stream|x-font-ttf));base64,[A-Za-z0-9+/=\s]+$/.test(imported.data))
      return;
    const font = new FontFace('Deft Imported', `url("${imported.data}")`);
    let mounted = true;
    void font.load().then(() => {
      if (mounted) document.fonts.add(font);
    }).catch(() => {});
    return () => { mounted = false; document.fonts.delete(font); };
  }, [currentSettings.importedFonts, currentSettings.readerFont]);

  useEffect(() => {
    if (!root.current || !chapters?.length) return;
    paintHighlights(root.current, bookNotes);
    return clearHighlights;
  }, [bookNotes, chapters, cursor.chapter, scrolling]);

  useEffect(() => {
    if (panel !== 'search' || !query.trim() || !opened) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    const request = new AbortController();
    const needle = query.trim();
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(async () => {
      try {
        const result = opened.pages?.search
          ? await opened.pages.search(needle, request.signal)
          : searchChapters(opened.chapters, needle);
        if (!request.signal.aborted) setSearchHits(result);
      } catch (error) {
        if (!request.signal.aborted) setSearchError(describeError(error));
      } finally {
        if (!request.signal.aborted) setSearching(false);
      }
    }, 180);
    return () => { request.abort(); window.clearTimeout(timer); };
  }, [opened, panel, query]);

  function emit(locator: Locator, intentional = false, turn = false) {
    location.current = locator;
    setCursor(previous => previous.chapter === locator.chapter && previous.offset === locator.offset && previous.progress === locator.progress
      ? previous : locator);
    tracking.move(locator, intentional, turn);
    if (intentional) canEnd.current = true;
  }

  function frameAt(index: number) {
    return viewport.current?.querySelector<HTMLElement>(`[data-fixed-page="${index}"]`);
  }

  function chapterAt(index: number) {
    return viewport.current?.querySelector<HTMLElement>(`[data-chapter="${index}"]`);
  }

  function pagesInChapter(): number {
    const view = viewport.current;
    return view ? Math.max(1, Math.ceil((view.scrollWidth - 2) / Math.max(1, view.clientWidth))) : 1;
  }

  function reveal(action: Jump): void {
    const view = viewport.current;
    if (!view) return;
    suppressScrollUntil.current = performance.now() + 150;
    let destination = action.locator;
    if (isFixed) {
      if (scrolling) {
        const node = frameAt(destination.chapter);
        if (node) view.scrollTop += node.getBoundingClientRect().top - view.getBoundingClientRect().top;
      } else {
        view.scrollTop = 0;
        view.scrollLeft = 0;
      }
    } else if (chapters) {
      const content = chapterAt(destination.chapter);
      if (content) {
        if (action.fragment) {
          const offset = anchorOffset(content, action.fragment);
          if (offset !== undefined) destination = getLocator(chapters, destination.chapter, offset);
        }
        if (scrolling) {
          const target = rangeForOffsets(content, destination.offset).getBoundingClientRect();
          const top = destination.offset && target.height ? target.top : content.getBoundingClientRect().top;
          view.scrollTop += top - view.getBoundingClientRect().top - 36;
        } else {
          const geometry = rangeForOffsets(content, destination.offset).getBoundingClientRect();
          const offset = geometry.width || geometry.height ? geometry.left - view.getBoundingClientRect().left + view.scrollLeft : 0;
          const column = action.lastColumn ? pagesInChapter() - 1 : Math.floor(Math.max(0, offset) / Math.max(1, view.clientWidth));
          view.scrollTop = 0;
          view.scrollLeft = column * view.clientWidth;
          if (action.lastColumn) {
            const first = visibleTextOffset(content, view) ?? destination.offset;
            destination = getLocator(chapters, destination.chapter, first);
          }
        }
      }
    }
    emit(destination, action.deliberate ?? false, action.turn ?? false);
  }

  useLayoutEffect(() => {
    if (!opened) return;
    const saved = pending.current;
    pending.current = null;
    reveal(saved ?? { locator: location.current });
  // Restore the character or page after changes that reflow content.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened?.chapters, opened?.pages, scrolling, !scrolling && cursor.chapter, viewportSize.width, viewportSize.height,
    currentSettings.readerFont, currentSettings.readerFontSize, currentSettings.readerLineSpacing, currentSettings.readerMargins,
    currentSettings.readerHyphenation, currentSettings.readerAlignment]);

  function navigate(destination: Locator, { remember = false, fragment, lastColumn = false, turn = false }: {
    remember?: boolean;
    fragment?: string;
    lastColumn?: boolean;
    turn?: boolean;
  } = {}) {
    setSelection(undefined);
    if (remember) setSkipBack(location.current);
    const action = { locator: destination, fragment, lastColumn, deliberate: true, turn };
    if (!scrolling && location.current.chapter !== destination.chapter) {
      pending.current = action;
      // Update the mounted chapter first. Its layout effect applies the locator.
      setCursor(destination);
    } else {
      reveal(action);
    }
  }

  function visibleTextOffset(content: HTMLElement, view: HTMLElement): number | undefined {
    const screen = view.getBoundingClientRect();
    const bounds = content.getBoundingClientRect();
    const x = Math.max(screen.left + 30, Math.min(bounds.left + 8, screen.left + screen.width * 0.44));
    const startY = Math.max(bounds.top + 3, screen.top + (scrolling ? 38 : 65));
    for (const y of [startY, startY + 20, startY + 45, startY + 80, startY + 130]) {
      for (const targetX of [x, screen.left + screen.width * 0.45, screen.left + screen.width * 0.25]) {
        const offset = offsetAtPoint(content, targetX, y);
        if (offset !== undefined) return offset;
      }
    }
    return undefined;
  }

  function activeIndex(view: HTMLElement, selector: string, total: number, target: number): number {
    let lo = 0;
    let hi = total - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const element = view.querySelector<HTMLElement>(`[${selector}="${mid}"]`);
      if (!element || element.getBoundingClientRect().bottom >= target) hi = mid;
      else lo = mid + 1;
    }
    return Math.max(0, lo);
  }

  function onScroll() {
    const view = viewport.current;
    if (!view || !opened || performance.now() < suppressScrollUntil.current || scrollEvent.current) return;
    scrollEvent.current = requestAnimationFrame(() => {
      scrollEvent.current = 0;
      const now = performance.now();
      const advance = now - cadence.current >= 400;
      if (advance) cadence.current = now;
      if (isFixed && scrolling) {
        const index = activeIndex(view, 'data-fixed-page', count, view.getBoundingClientRect().top + view.clientHeight * 0.4);
        const atEnd = view.scrollTop + view.clientHeight >= view.scrollHeight - 5;
        emit(pageLocator(atEnd ? count - 1 : index, count), true, advance && index !== location.current.chapter);
      } else if (chapters?.length) {
        let index = location.current.chapter;
        if (scrolling) index = activeIndex(view, 'data-chapter', count, view.getBoundingClientRect().top + 45);
        const content = chapterAt(index);
        if (!content) return;
        const atEnd = scrolling && view.scrollTop + view.clientHeight >= view.scrollHeight - 5;
        const offset = atEnd ? chapters.at(-1)?.length ?? 0 : visibleTextOffset(content, view) ?? 0;
        emit(getLocator(chapters, atEnd ? count - 1 : index, offset), true, advance);
      } else {
        tracking.move(location.current, true);
      }
      askIfFinished();
    });
  }

  function askIfFinished(force = false): void {
    if (!ready || !canEnd.current || mode === 'browse' || once.current || !count) return;
    const end = isFixed
      ? location.current.chapter === count - 1
      : location.current.progress >= 0.99 || force;
    if (!end) return;
    once.current = true;
    void tracking.finishPrompt().then(ask => {
      if (ask === undefined) once.current = false;
      if (ask && !closeRequested.current) setFinish('ask');
    }).catch(error => { once.current = false; notice(describeError(error)); });
  }

  function turn(direction: number, withinChapter = true): void {
    const view = viewport.current;
    if (!opened || !count || !view) return;
    const current = location.current;
    canEnd.current = true;
    if (isFixed) {
      const index = clamp(current.chapter + direction, 0, count - 1);
      navigate(pageLocator(index, count), { turn: index !== current.chapter });
      askIfFinished();
      return;
    }
    if (!chapters) return;
    if (scrolling && withinChapter) {
      const previous = view.scrollTop;
      view.scrollTop += direction * Math.max(1, view.clientHeight * 0.84);
      if (previous === view.scrollTop && direction > 0) {
        emit(getLocator(chapters, count - 1, chapters.at(-1)?.length ?? 0), true);
        askIfFinished();
      }
      return;
    }
    if (!scrolling && withinChapter) {
      const column = Math.round(view.scrollLeft / Math.max(1, view.clientWidth));
      const nextColumn = column + direction;
      if (nextColumn >= 0 && nextColumn < pagesInChapter()) {
        const target = nextColumn * view.clientWidth;
        suppressScrollUntil.current = performance.now() + 450;
        const motion = currentSettings.readerAnimation === 'slide' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
        view.scrollTo({ left: target, behavior: motion ? 'smooth' : 'instant' });
        const take = () => {
          if (!view.isConnected || location.current.chapter !== current.chapter) return;
          const content = chapterAt(current.chapter);
          const offset = content && visibleTextOffset(content, view);
          const end = current.chapter === count - 1 && nextColumn === pagesInChapter() - 1;
          emit(getLocator(chapters, current.chapter, end ? chapters[current.chapter].length : offset || 0), true, true);
          askIfFinished(end);
        };
        if (motion) window.setTimeout(take, 380);
        else requestAnimationFrame(take);
        return;
      }
    }
    const index = current.chapter + direction;
    if (index >= 0 && index < count) {
      navigate(getLocator(chapters, index, 0), { lastColumn: !scrolling && direction < 0, turn: true });
    } else if (direction > 0) {
      emit(getLocator(chapters, count - 1, chapters.at(-1)?.length ?? 0), true);
      askIfFinished(true);
    }
  }

  function seek(value: number, remember = false) {
    const locator = isFixed ? pageLocator(Math.round(value * (count - 1)), count)
      : locatorAtProgress(chapters ?? [], value);
    navigate(locator, { remember });
  }

  function selectPanel(next: ReadingPanel) {
    setChrome(true);
    setPanel(previous => previous === next ? null : next);
  }

  function openPanelAt(destination: Locator, fragment?: string) {
    navigate(destination, { remember: true, fragment });
    setPanel(null);
  }

  function patchSettings(patch: Partial<Settings>) {
    setTemporarySettings(previous => ({ ...previous, ...patch }));
    void Promise.resolve(updateSettings(patch)).catch(error => notice(describeError(error))).finally(() => {
      setTemporarySettings(previous => {
        const next = { ...previous };
        for (const key of Object.keys(patch)) if (next[key] === patch[key]) delete next[key];
        return next;
      });
    });
  }

  const fixedSave = useRef(Promise.resolve());
  const fixedLive = useRef(preferences);
  function patchFixed(patch: Record<string, unknown>) {
    const value = { ...fixedLive.current, ...patch };
    fixedLive.current = value;
    setPreferences(value);
    fixedSave.current = fixedSave.current.then(async () => {
      await rpc('bookPatch', { bookId: openedId, fixed: value });
    }).catch(error => { notice(describeError(error)); });
  }

  function changeZoom(value: number) {
    patchFixed({ zoom: Math.round(clamp(value, 0.5, 4) * 100) / 100 });
    tracking.move(location.current, true);
  }

  function toggleFullscreen() {
    const next = !immersive;
    void rpc('fullscreen', { value: next }).then(() => setImmersive(next))
      .catch(error => notice(describeError(error)));
  }

  async function leave() {
    if (closeRequested.current) return;
    closeRequested.current = true;
    setBusy(true);
    await tracking.close();
    await fixedSave.current;
    if (immersive) await rpc('fullscreen', { value: false }).catch(() => {});
    await close();
  }

  async function noteSave(note: AnnotationDraft) {
    try {
      await rpc<Annotation>('noteSave', { annotation: { ...note, bookId: openedId } });
      setSelection(undefined);
      lastSelection.current = undefined;
      window.getSelection()?.removeAllRanges();
      setDraft(undefined);
      await refresh();
    } catch (error) {
      notice(describeError(error));
    }
  }

  async function noteDelete(note: Annotation) {
    try {
      await rpc('noteDelete', { id: note.id });
      setDraft(undefined);
      await refresh();
    } catch (error) {
      notice(describeError(error));
    }
  }

  function toggleBookmark() {
    if (bookmark) { void noteDelete(bookmark); return; }
    const current = location.current;
    const content = chapters?.[current.chapter];
    const label = !content ? `page ${current.chapter + 1}` :
      content.text.slice(current.offset, current.offset + 80).trim().replace(/\s+/g, ' ') || content.title;
    void noteSave({ kind: 'bookmark', locator: current, text: label, note: '', color: 'purple' });
  }

  function openPageNote() {
    if (pageNote) setDraft(pageNote);
    else setDraft({ kind: 'page', locator: location.current, text: '', note: '', color: 'purple' });
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notice('Copied to clipboard.');
    } catch (error) {
      notice(describeError(error));
    }
  }

  async function shareText(value: string) {
    if (navigator.canShare?.({ text: value })) {
      await navigator.share({ title: book.title, text: value }).catch(error => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) notice(describeError(error));
      });
    } else {
      await copyText(value);
    }
  }

  async function defineText(value: string) {
    try {
      if (!currentSettings.dictionaryPath) {
        const configured = await rpc<string | null>('chooseDictionary');
        if (!configured) return;
        await refresh();
      }
      await rpc('defineSelection', { text: value.trim().replace(/\s+/g, ' ').slice(0, 160) });
    } catch (error) {
      notice(describeError(error));
    }
  }

  function catchSelection() {
    if (isFixed || !chapters) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) {
      if (lastSelection.current && !draft) {
        lastSelection.current = undefined;
        setSelection(undefined);
      }
      return;
    }
    const range = selected.getRangeAt(0);
    const start = range.startContainer.parentElement?.closest<HTMLElement>('[data-chapter]');
    const end = range.endContainer.parentElement?.closest<HTMLElement>('[data-chapter]');
    if (!start || start !== end || !viewport.current?.contains(start)) return;
    const chapterIndex = Number(start.dataset.chapter);
    const offset = offsetIn(start, range.startContainer, range.startOffset);
    const value = {
      locator: getLocator(chapters, chapterIndex, offset), text: selected.toString().trim(),
      end: offsetIn(start, range.endContainer, range.endOffset),
    };
    if (!value.text || value.end <= offset || lastSelection.current?.locator.offset === offset && lastSelection.current?.end === value.end
      && lastSelection.current?.locator.chapter === chapterIndex) return;
    lastSelection.current = value;
    tracking.move(location.current, true);
    setSelection(value);
  }

  useEffect(() => {
    document.addEventListener('selectionchange', catchSelection);
    return () => document.removeEventListener('selectionchange', catchSelection);
  });

  function onPaperClick(event: MouseEvent<HTMLDivElement>) {
    const view = viewport.current;
    if (!view || !opened || event.defaultPrevented) return;
    if (panned.current) { panned.current = false; return; }
    const node = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (node && chapters?.length) {
      event.preventDefault();
      const href = node.getAttribute('href') ?? '';
      const match = /^(?:deft-chapter:(\d+))?(?:#(.*))?$/.exec(href);
      if (match) {
        const index = match[1] === undefined ? location.current.chapter : Number(match[1]);
        if (chapters[index]) navigate(getLocator(chapters, index, 0), { remember: true, fragment: match[2] });
      }
      return;
    }
    if (!window.getSelection()?.isCollapsed || selection) return;
    const bounds = view.getBoundingClientRect();
    const fraction = (event.clientX - bounds.left) / bounds.width;
    if (fraction > 0.23 && fraction < 0.77 || scrolling) {
      setChrome(previous => !previous);
      setPanel(null);
      return;
    }
    turn((fraction < 0.23 ? -1 : 1) * (rtl ? -1 : 1));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!isFixed || !viewport.current || event.pointerType !== 'mouse' || event.button !== 0 || zoom <= 1) return;
    panned.current = false;
    pointerStart.current = {
      x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft,
      top: viewport.current.scrollTop, panning: false,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const anchor = pointerStart.current;
    const view = viewport.current;
    if (!anchor || !view) return;
    const dx = event.clientX - anchor.x;
    const dy = event.clientY - anchor.y;
    if (!anchor.panning && Math.hypot(dx, dy) < 6) return;
    anchor.panning = true;
    view.scrollLeft = anchor.left - dx;
    view.scrollTop = anchor.top - dy;
    tracking.move(location.current, true);
  }

  function onPhoneTouchStart(event: TouchEvent<HTMLDivElement>) {
    const first = event.touches[0];
    if (!first) return;
    const second = event.touches[1];
    touchStart.current = { x: first.clientX, y: first.clientY, zoom, distance: second ?
      Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY) : 0 };
  }

  function onPhoneTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const initial = touchStart.current;
    const first = event.changedTouches[0];
    if (!initial || !first) return;
    const other = event.touches[0];
    touchStart.current = undefined;
    if (isFixed && initial.distance && other) {
      const moved = Math.hypot(first.clientX - other.clientX, first.clientY - other.clientY);
      changeZoom(initial.zoom * moved / initial.distance);
    } else if (!scrolling && !initial.distance) {
      const dx = first.clientX - initial.x;
      const dy = first.clientY - initial.y;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) turn((dx < 0 ? 1 : -1) * (rtl ? -1 : 1));
    }
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const key = event.key;
      if (key === 'Escape') {
        if (finish || draft || password) return;
        event.preventDefault();
        if (selection) {
          setSelection(undefined);
          window.getSelection()?.removeAllRanges();
        } else if (panel) setPanel(null);
        else if (immersive) toggleFullscreen();
        else if (!chrome) setChrome(true);
        else void leave();
        return;
      }
      if (finish || draft || password || !opened) return;
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'f') {
        event.preventDefault();
        selectPanel('search');
        return;
      }
      if (key === 'F11') {
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      if (event.target instanceof Element && event.target.closest('input,textarea,select,button,[contenteditable]')) return;
      if (key === 'b' && !event.ctrlKey && !event.metaKey && !event.altKey) toggleBookmark();
      else if (key === 'ArrowRight' || key === 'ArrowLeft') {
        event.preventDefault();
        turn((key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1));
      } else if (key === 'PageDown' || key === 'PageUp' || key === ' ') {
        event.preventDefault();
        turn(key === 'PageUp' || key === ' ' && event.shiftKey ? -1 : 1);
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault();
        seek(key === 'Home' ? 0 : 1, true);
      } else if (currentSettings.readerVolumeKeys && (key === 'AudioVolumeDown' || key === 'AudioVolumeUp')) {
        event.preventDefault();
        turn(key === 'AudioVolumeDown' ? 1 : -1);
      } else if (isFixed && (key === '+' || key === '=' || key === '-')) {
        event.preventDefault();
        changeZoom(zoom + (key === '-' ? -0.25 : 0.25));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const wheel = (event: WheelEvent) => {
      if (isFixed && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
      } else if (!isFixed && !scrolling && !event.ctrlKey && Math.abs(event.deltaY) > 8) {
        event.preventDefault();
        const now = performance.now();
        if (now - lastPagedTurn.current < 330) return;
        lastPagedTurn.current = now;
        turn(event.deltaY > 0 ? 1 : -1);
      }
    };
    view.addEventListener('wheel', wheel, { passive: false });
    return () => view.removeEventListener('wheel', wheel);
  });

  const pageIsReady = useCallback((index: number) => {
    if (location.current.chapter === index) setReady(true);
  }, []);
  const customTheme = currentSettings.readerFollowSystem
    ? systemDark ? currentSettings.readerNightTheme ?? 'dark' : currentSettings.readerDayTheme ?? 'light'
    : currentSettings.readerTheme ?? 'sepia';
  const theme = [...READER_THEMES, ...(currentSettings.customThemes ?? [])].find(candidate => candidate.id === customTheme) ?? LIGHT_FALLBACK;
  const margins = currentSettings.readerMargins ?? 'm';
  const gutter = clamp(viewportSize.width * (margins === 's' ? 0.06 : margins === 'l' ? 0.17 : 0.12),
    20, Math.max(20, (viewportSize.width - (margins === 's' ? 940 : margins === 'l' ? 620 : 760)) / 2 + 48));
  const imported = (currentSettings.importedFonts ?? []).some((font: { name: string }) => font.name === currentSettings.readerFont);
  const fontName = currentSettings.readerFont ?? 'Literata';
  const textFamily = imported ? '"Deft Imported", Georgia, serif' : fontName === 'original' || fontName === 'Original'
    ? 'Georgia, serif' : `"${String(fontName).replace(/[";<>\\]/g, '')}", Georgia, serif`;
  const themeStyle = {
    '--r-bg': theme.background,
    '--r-fg': theme.text,
    '--r-accent': theme.accent,
    '--r-gutter': `${gutter}px`,
    '--r-width': `${viewportSize.width}px`,
    '--r-height': `${viewportSize.height}px`,
    '--r-family': textFamily,
    '--r-size': `${clamp(Number(currentSettings.readerFontSize ?? 20), 11, 56)}px`,
    '--r-line-height': clamp(Number(currentSettings.readerLineSpacing ?? 1.65), 1.1, 2.8),
    '--r-align': currentSettings.readerAlignment === 'justify' ? 'justify' : 'start',
    '--r-hyphens': currentSettings.readerHyphenation === true ? 'auto' : 'manual',
    '--r-dim': currentSettings.readerUseSystemBrightness !== false ? 0 : 1 - clamp(Number(currentSettings.readerBrightness ?? 100), 25, 100) / 100,
  } as CSSProperties;

  async function markFinished() {
    setBusy(true);
    try {
      await tracking.close();
      await rpc('bookState', { bookId: openedId, outcome: 'finished', zoneOffsetMinutes: -new Date().getTimezoneOffset() });
      await refresh();
      setFinish('rate');
    } catch (error) {
      notice(describeError(error));
      setFinish(null);
    } finally {
      setBusy(false);
    }
  }

  async function saveRating(event: FormEvent) {
    event.preventDefault();
    try {
      if (rating !== '' || favorite !== book.favorite) {
        const patch = rating === '' ? { favorite } : { favorite, rating: Number(rating) };
        await rpc('bookPatch', { bookId: openedId, ...patch });
      }
      setFinish(null);
      await leave();
    } catch (error) {
      notice(describeError(error));
    }
  }

  const where = isFixed ? `page ${cursor.chapter + 1} of ${count}`
    : `ch. ${cursor.chapter + 1} of ${count}`;
  const displayProgress = isFixed && count ? (cursor.chapter + 1) / count : cursor.progress;
  const slider = isFixed ? cursor.progress : displayProgress;
  const remaining = estimateSeconds && book.progress < 1
    ? Math.round(estimateSeconds * (1 - cursor.progress) / Math.max(0.01, 1 - book.progress) / 60) : 0;
  const timeLeft = remaining >= 60 ? `${Math.floor(remaining / 60)}h ${remaining % 60}m left` : `${remaining}m left`;
  const ticks = !isFixed && chapters && chapters.length <= 48
    ? chapters.map((_, index) => Math.round(getLocator(chapters, index, 0).progress * 1000)) : [];
  const panelTitle = panel === 'contents' ? 'contents' : panel === 'search' ? 'in-book search'
    : panel === 'bookmarks' ? 'bookmarks & notes' : 'reader settings';
  const safeLang = opened?.language?.match(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/) ? opened.language : undefined;
  const toc = opened?.toc ?? [];
  const controlsVisible = chrome || Boolean(panel) || !opened;

  return <main className="reader-shell" ref={root} style={themeStyle} aria-label={`reader for ${book.title}`}>
    <div className={`reader-viewport ${isFixed ? 'is-fixed' : 'is-text'} ${scrolling ? 'is-scroll' : 'is-paged'}`}
      ref={viewport} onScroll={onScroll} onClick={onPaperClick}
      onContextMenu={event => event.preventDefault()}
      onDoubleClick={event => { if (isFixed && opened) { event.preventDefault(); changeZoom(zoom > 1 ? 1 : 2); } }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={event => {
        if (pointerStart.current?.panning) {
          suppressScrollUntil.current = performance.now() + 150;
          panned.current = true;
          event.preventDefault();
        }
        pointerStart.current = null;
      }} onPointerCancel={() => { pointerStart.current = null; }}
      onPointerLeave={() => { pointerStart.current = null; }}
      onTouchStart={onPhoneTouchStart} onTouchEnd={onPhoneTouchEnd}>
      {loadError ? <div className="reader-empty" role="alert"><BookOpen size={30} /><h2>couldn’t open this book</h2>
        <p>{loadError}</p><button className="reader-primary" onClick={() => void leave()}>back to library</button></div>
        : !opened ? <div className="reader-empty" role="status"><LoaderCircle className="reader-spin" size={27} />
          <h2>opening book</h2><p>{book.title}</p></div>
          : opened.pages
            ? scrolling
              ? <div className="reader-fixed-flow">{Array.from({ length: count }, (_, index) =>
                <FixedPage key={index} source={opened.pages!} page={index} display={Math.abs(index - cursor.chapter) <= 2}
                  viewport={viewportSize} fit={fit} zoom={zoom} crop={crop} invert={invert} continuous onReady={pageIsReady} />)}</div>
              : <FixedPage key={cursor.chapter} source={opened.pages} page={cursor.chapter} display
                viewport={viewportSize} fit={fit} zoom={zoom} crop={crop} invert={invert} continuous={false} onReady={pageIsReady} />
            : <div className={`reader-paper ${scrolling ? 'reader-paper-scroll' : 'reader-paper-paged'}`} lang={safeLang}>
              {scrolling ? opened.chapters.map((entry, index) => <BookChapter key={index} chapter={entry} index={index} />)
                : chapter && <BookChapter key={cursor.chapter} chapter={chapter} index={cursor.chapter} />}
            </div>}
    </div>

    <header className={`reader-chrome reader-top ${controlsVisible ? 'is-shown' : ''}`}>
      <ReaderButton label="back to library (Esc)" onClick={() => void leave()} disabled={busy}><ArrowLeft size={20} /></ReaderButton>
      <div className="reader-heading"><strong>{book.title}</strong><span>{chapter?.title || (count ? where : book.authors.join(', '))}</span></div>
      <div className="reader-actions">
        {count > 0 && <>
          <ReaderButton label="contents" onClick={() => selectPanel('contents')} pressed={panel === 'contents'}><List size={19} /></ReaderButton>
          <ReaderButton label="search in book (Ctrl+F)" onClick={() => selectPanel('search')} pressed={panel === 'search'}><Search size={18} /></ReaderButton>
          <ReaderButton label={bookmark ? 'remove bookmark (B)' : 'bookmark here (B)'} onClick={toggleBookmark} pressed={Boolean(bookmark)}>
            <Bookmark size={18} fill={bookmark ? 'currentColor' : 'none'} />
          </ReaderButton>
          <ReaderButton label={isFixed ? 'page note' : 'bookmarks and notes'} onClick={isFixed ? openPageNote : () => selectPanel('bookmarks')}
            pressed={isFixed ? Boolean(pageNote) : panel === 'bookmarks'}><NotebookPen size={18} /></ReaderButton>
        </>}
        <ReaderButton label="reader settings" onClick={() => selectPanel('settings')} pressed={panel === 'settings'}><SlidersHorizontal size={19} /></ReaderButton>
        <ReaderButton label={immersive ? 'exit fullscreen (F11)' : 'fullscreen (F11)'} onClick={toggleFullscreen} pressed={immersive}>
          {immersive ? <PanelTop size={18} /> : <Fullscreen size={19} />}
        </ReaderButton>
      </div>
    </header>

    {count > 0 && <footer className={`reader-chrome reader-bottom ${controlsVisible ? 'is-shown' : ''}`}>
      <ReaderButton label={rtl ? 'next page' : 'previous page'} onClick={() => turn(rtl ? 1 : -1)}>
        <ChevronLeft size={21} />
      </ReaderButton>
      <div className="reader-progress-controls">
        <input type="range" min="0" max="1000" step="1" list={ticks.length ? "reader-chapter-ticks" : undefined}
          value={Math.round(slider * 1000)}
          onChange={event => seek(Number(event.target.value) / 1000)}
          onPointerUp={() => askIfFinished()} onKeyUp={() => askIfFinished()}
          aria-label="book progress" aria-valuetext={`${percent(displayProgress)} percent, ${where}`} />
        <datalist id="reader-chapter-ticks">{ticks.map((tick, index) => <option key={index} value={tick} />)}</datalist>
        <div><span>{where}</span><span>{percent(displayProgress)}%</span>{remaining > 0 && <span>{timeLeft}</span>}
          {currentSettings.trackingIndicator && <span className="reader-tracking">
            <i data-active={tracking.status.active} /> {Math.floor(tracking.status.seconds / 60)}m {tracking.status.seconds % 60}s
          </span>}</div>
      </div>
      <ReaderButton label={rtl ? 'previous page' : 'next page'} onClick={() => turn(rtl ? -1 : 1)}>
        <ChevronRight size={21} />
      </ReaderButton>
      {isFixed && <div className="reader-zoom-controls">
        <ReaderButton label="zoom out" onClick={() => changeZoom(zoom - 0.25)}><Minus size={17} /></ReaderButton>
        <span>{Math.round(zoom * 100)}%</span>
        <ReaderButton label="zoom in" onClick={() => changeZoom(zoom + 0.25)}><Plus size={17} /></ReaderButton>
      </div>}
      {skipBack && <button className="reader-subtle reader-go-back" onClick={() => {
        navigate(skipBack); setSkipBack(undefined);
      }}><ArrowLeft size={15} /> go back</button>}
    </footer>}

    {(currentSettings.readerStatusLine || currentSettings.trackingIndicator) && !controlsVisible && count > 0 &&
      <div className="reader-statusline">
        {currentSettings.readerStatusLine && <>
          <span>{statusTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span>{percent(displayProgress)}%</span>
          {battery !== undefined && <span>{battery}% battery</span>}
        </>}
        {currentSettings.trackingIndicator && <span className="reader-tracking">
          <i data-active={tracking.status.active} /> {Math.floor(tracking.status.seconds / 60)}m {tracking.status.seconds % 60}s
        </span>}
      </div>}

    {panel && <aside className="reader-panel" aria-label={panelTitle}>
      <div className="reader-panel-heading"><h2>{panelTitle}</h2>
        <ReaderButton label="close panel" onClick={() => setPanel(null)}><X size={20} /></ReaderButton>
      </div>
      {panel === 'settings' && <ReaderPreferences settings={currentSettings} patch={patchSettings}
        compact fixed={isFixed ? preferences : undefined} bookFormat={book.format} onFixed={patchFixed} />}
      {panel === 'contents' && <>
        <div className="reader-panel-tools">
          <button className="reader-subtle" onClick={() => setPanel('bookmarks')}><Bookmark size={15} /> bookmarks & notes</button>
          {isFixed && <button className="reader-subtle" onClick={openPageNote}><NotebookPen size={15} /> page note</button>}
        </div>
        {toc.length ? <ul className="reader-nav-list">{toc.map((entry, index) =>
          <li key={`${entry.chapter}-${index}`}><button data-current={entry.chapter === cursor.chapter}
            onClick={() => openPanelAt(isFixed ? pageLocator(entry.chapter, count) : getLocator(chapters ?? [], entry.chapter, 0),
              entry.href?.split('#')[1])}><span>{entry.title}</span><span>{entry.chapter + 1}</span></button></li>)}</ul>
          : isFixed && <form className="reader-short-form" onSubmit={event => {
            event.preventDefault();
            const number = Number(new FormData(event.currentTarget).get('page'));
            openPanelAt(pageLocator(number - 1, count));
          }}>
            <label>go to page<input name="page" type="number" min="1" max={count} defaultValue={cursor.chapter + 1} required /></label>
            <button className="reader-primary" type="submit"><ArrowRight size={16} /> go</button>
          </form>}
      </>}
      {panel === 'search' && <>
        {isFixed && !opened?.pages?.search ? <p className="reader-panel-copy">Text search is available for reflowable books and PDFs with a text layer.</p>
          : <label className="reader-search">
            <Search size={18} /><input autoFocus type="search" placeholder="find a passage" value={query}
              onChange={event => setQuery(event.target.value)} aria-label="find a passage" />
          </label>}
        {searching ? <p className="reader-panel-copy" role="status">Searching…</p> :
          searchError ? <p className="reader-panel-copy" role="alert">{searchError}</p> :
          searchHits.length ? <ul className="reader-nav-list reader-search-results">{searchHits.map((hit, index) =>
            <li key={index}><button onClick={() => openPanelAt(hit.locator)}><span>{hit.excerpt}</span>
              <span>{isFixed ? 'page' : 'ch.'} {hit.locator.chapter + 1}</span></button></li>)}</ul>
            : query.trim() && <p className="reader-panel-copy">No passages found.</p>}
      </>}
      {panel === 'bookmarks' && (bookNotes.length ? <ul className="reader-nav-list reader-note-list">
        {[...bookNotes].sort((a, b) => a.locator.chapter - b.locator.chapter || a.locator.offset - b.locator.offset)
          .map(note => <li key={note.id}>
            <button onClick={() => openPanelAt(isFixed ? pageLocator(note.locator.chapter, count)
              : restoreTextLocator(chapters ?? [], note.locator))}>
              <span>{note.note || note.text || 'page note'}</span><span>{isFixed ? 'page' : 'ch.'} {note.locator.chapter + 1}</span>
            </button>
            <ReaderButton label="edit note" onClick={() => setDraft(note)}><NotebookPen size={15} /></ReaderButton>
          </li>)}
      </ul> : <p className="reader-panel-copy">Bookmarks, highlights and page notes for this book appear here.</p>)}
    </aside>}

    {selection && !draft && <div className="reader-selection" role="toolbar" aria-label="selected passage"
      onMouseDown={event => event.preventDefault()}>
      <div className="reader-selection-colors">{Object.entries(NOTE_COLORS).map(([color, value]) =>
        <button key={color} type="button" className="reader-color" title={`highlight ${color}`} aria-label={`highlight ${color}`}
          style={{ '--note-color': value } as CSSProperties}
          onClick={() => void noteSave({ ...selection, kind: 'highlight', note: '', color })} />)}</div>
      <ReaderButton label="add note" onClick={() => setDraft({ ...selection, kind: 'highlight', note: '', color: 'purple' })}><NotebookPen size={18} /></ReaderButton>
      <ReaderButton label="copy selected text" onClick={() => void copyText(selection.text)}><Clipboard size={18} /></ReaderButton>
      <ReaderButton label="share selected text" onClick={() => void shareText(selection.text)}><Share2 size={18} /></ReaderButton>
      <ReaderButton label="define selected text" onClick={() => void defineText(selection.text)}><BookText size={17} /></ReaderButton>
      <ReaderButton label="search for selected text" onClick={() => { setQuery(selection.text); setSelection(undefined); selectPanel('search'); }}><Search size={17} /></ReaderButton>
      <ReaderButton label="close selection actions" onClick={() => {
        setSelection(undefined); lastSelection.current = undefined; window.getSelection()?.removeAllRanges();
      }}><X size={17} /></ReaderButton>
    </div>}
    {!!Number(themeStyle['--r-dim' as keyof CSSProperties]) && <div className="reader-dimmer" aria-hidden="true" />}

    {password && <ReaderDialog title="password required">
      <form onSubmit={event => {
        event.preventDefault();
        password.submit(passwordText);
        setPassword(undefined);
        setPasswordText('');
      }}>
        <p>{password.incorrect ? 'That password didn’t open the PDF. Try again.' : 'Enter the password to open this PDF.'}</p>
        <label>password<input type="password" autoComplete="off" value={passwordText} autoFocus
          onChange={event => setPasswordText(event.target.value)} required /></label>
        <div className="reader-dialog-actions"><button className="reader-subtle" type="button"
          onClick={() => void leave()}>cancel</button><button className="reader-primary" type="submit">open PDF</button></div>
      </form>
    </ReaderDialog>}

    {draft && <ReaderDialog title={draft.kind === 'bookmark' ? 'edit bookmark' : draft.kind === 'page' ? 'page note' : 'reading note'}
      dismiss={() => setDraft(undefined)}>
      <form onSubmit={event => { event.preventDefault(); void noteSave(draft); }}>
        {draft.kind === 'highlight' && <blockquote>{draft.text}</blockquote>}
        {draft.kind === 'bookmark'
          ? <label>label<input autoFocus value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })}
            maxLength={240} required /></label>
          : <label>note<textarea autoFocus value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })}
            rows={4} required={draft.kind === 'page'} /></label>}
        {draft.kind === 'highlight' && <div className="reader-selection-colors">{Object.entries(NOTE_COLORS).map(([color, value]) =>
          <button type="button" key={color} className="reader-color" aria-label={color} aria-pressed={draft.color === color}
            style={{ '--note-color': value } as CSSProperties} onClick={() => setDraft({ ...draft, color })} />)}</div>}
        <div className="reader-dialog-actions">
          {draft.id && <button className="reader-subtle" type="button" onClick={() => {
            const existing = bookNotes.find(note => note.id === draft.id);
            if (existing) void noteDelete(existing);
          }}>delete</button>}
          <button className="reader-subtle" type="button" onClick={() => setDraft(undefined)}>cancel</button>
          <button className="reader-primary" type="submit">save</button>
        </div>
      </form>
    </ReaderDialog>}

    {finish === 'ask' && <ReaderDialog title="reached the end." dismiss={() => setFinish(null)}>
      <p>Mark it finished?</p>
      <div className="reader-dialog-actions">
        <button className="reader-subtle" onClick={() => setFinish(null)}>not yet</button>
        <button className="reader-primary" onClick={() => void markFinished()} disabled={busy}><Check size={16} /> finished</button>
      </div>
    </ReaderDialog>}
    {finish === 'rate' && <ReaderDialog title="finished.">
      <form onSubmit={saveRating}>
        <p>{book.title} is marked finished.</p>
        <label>rating<select value={rating} onChange={event => setRating(event.target.value)}>
          <option value="">skip rating</option>
          {Array.from({ length: 10 }, (_, index) => (index + 1) / 2).map(value =>
            <option key={value} value={value}>{value.toFixed(1)} / 5</option>)}
        </select></label>
        <div className="reader-dialog-actions">
          <button className="reader-subtle" type="button" aria-pressed={favorite} onClick={() => setFavorite(!favorite)}>
            <Heart size={16} fill={favorite ? 'currentColor' : 'none'} /> favourite
          </button>
          <button className="reader-primary" type="submit">done</button>
        </div>
      </form>
    </ReaderDialog>}
  </main>;
}

export default Reader;
