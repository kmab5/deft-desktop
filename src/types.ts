export const formats = ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'txt', 'pdf', 'djvu', 'cbz'] as const;
export type BookState = 'not_read' | 'reading' | 'paused' | 'finished' | 'abandoned';
export const stateName: Record<BookState, string> = {
  not_read: 'not read', reading: 'reading', paused: 'paused', finished: 'finished', abandoned: 'abandoned',
};
export type ReadingMode = 'normal' | 'resume' | 'restart' | 'reread' | 'browse';
export interface Locator { chapter: number; offset: number; progress: number; position: number; href?: string; page?: number }
export interface Metadata {
  title: string; authors: string[]; series?: string; seriesIndex?: number; language?: string;
  publisher?: string; publishedDate?: string; description?: string; isbn10?: string; isbn13?: string;
  pageCount?: number; cover?: string; protected: boolean;
}
export interface BookFile { path: string; size: number; modified: number; missing: boolean; lastSeenAt?: number }
export interface Edition {
  provider: string; title: string; authors: string[]; isbn10?: string; isbn13?: string; year?: number;
  pages?: number; workId?: string; editionId?: string; googleBooksId?: string; hardcoverId?: string;
  coverUrl?: string; exactIsbn?: boolean; confirmedAt?: number;
}
export interface Book {
  id: string; title: string; authors: string[]; authorIds: string[]; format: string; metadata: Metadata;
  files: BookFile[]; addedAt: number; lastOpenedAt?: number; ignored: boolean; missing: boolean;
  rating?: number | null; review: string; favorite: boolean; progress: number; state: BookState;
  locator?: Locator; fixed?: Record<string, unknown>; pageCount?: number; cover?: string;
  series?: string; seriesIndex?: number; edition?: Edition; protected: boolean;
  overrides?: {title?: string; authors?: string[]; cover?: string; series?: string; seriesIndex?: number};
}
export interface Author {id: string; name: string; bookIds: string[]}
export interface CategoryType {id: string; name: string; builtIn: boolean}
export interface Member {bookId: string; position: number; suggested: boolean; addedAt: number}
export interface Category {
  id: string; name: string; description: string; typeIds: string[]; members: Member[];
  cover?: string; rating?: number | null; orderMode: string; sortReversed?: boolean; autoCreated: boolean; createdAt: number;
}
export interface Annotation {
  id: string; bookId: string; kind: 'bookmark' | 'highlight' | 'page'; locator: Locator;
  text: string; note: string; color: string; end?: number; createdAt: number; updatedAt: number;
}
export interface ReadThrough {
  id: string; bookId: string; startedAt: number; endedAt?: number;
  outcome: Exclude<BookState,'not_read'>; prompted?: boolean; zoneOffsetMinutes?: number;
}
export interface Session {
  id: string; bookId: string; readThroughId: string; startedAt: number; endedAt: number;
  activeSeconds: number; browsing: boolean; zoneOffsetMinutes: number; pagesTurned: number;
  startLocator: Locator; endLocator: Locator;
}
export interface Folder {id: string; path: string; exclusions: string[]; available: boolean}
// Settings are versioned by the data store and individual sections read their own keys.
export type Settings = Record<string, any>;
export interface ScanReport {added: number; missing: number; errors: string[]; scanned: number; skipped?: boolean}
export interface Snapshot {
  books: Book[]; authors: Author[]; categories: Category[]; types: CategoryType[];
  annotations: Annotation[]; readThroughs: ReadThrough[]; sessions: Session[];
  folders: Folder[]; settings: Settings; lastScan?: number; cacheBytes?: number;
}
