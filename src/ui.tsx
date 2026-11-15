import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { CircleHelp, FolderPlus, LibraryBig, X } from 'lucide-react';
import { stateName, type Book, type BookState, type Category } from './types';

export function Mark({ size = 34, className }: { size?: number; className?: string }) {
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 128 128" fill="none">
    <rect x="31" y="24" width="66" height="81" rx="7" stroke="currentColor" strokeWidth="11"/>
    <path d="M49 27v76" stroke="currentColor" strokeWidth="10"/>
    <path d="M66 16h17v50l-8.5-7.5L66 66z" fill="#c373ff"/>
  </svg>;
}

const coverPalette = [
  ['#2a2225', '#d99a75', '#e5b69d'], ['#20292b', '#7eafad', '#c8d8d3'],
  ['#2e2333', '#a992c6', '#e0d2ea'], ['#262a24', '#aab186', '#dddcb6'],
  ['#2e2639', '#987ebc', '#d7c8e8'], ['#322721', '#c49973', '#e2c6a2'],
];

export function Cover({ book, className = '' }: { book: Book; className?: string }) {
  const palette = coverPalette[parseInt(book.id.slice(0, 5), 16) % coverPalette.length] ?? coverPalette[0];
  return <div className={`cover ${className}`} aria-hidden="true">
    {book.cover && /^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(book.cover) ?
      <img src={book.cover} loading="lazy" alt="" /> :
      <div className="cover-generated" style={{'--book-ink': palette[0], '--book-line': palette[1], '--book-text': palette[2]} as CSSProperties}>
        <span>{book.title}</span><i/><small>{book.authors[0] || book.format.toUpperCase()}</small>
      </div>}
  </div>;
}

export function Collage({ category, books }: { category: Category; books: Book[] }) {
  if (category.cover && /^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(category.cover)) {
    return <div className="collage"><img className="collage-cover" src={category.cover} alt=""/></div>;
  }
  const show = category.members.slice(0, 16).map(({bookId}) => books.find(book => book.id === bookId))
    .filter((book): book is Book => !!book && !book.ignored).slice(0, 4);
  return <div className={`collage collage-${show.length}`} aria-hidden="true">
    {show.length ? show.map(book => <Cover key={book.id} book={book}/>) : <LibraryBig size={30}/>}
  </div>;
}

export function StatePill({ state }: { state: BookState }) {
  return <span className={`state-pill state-${state}`}><i/>{stateName[state]}</span>;
}

export function Progress({ state, progress }: { state: BookState; progress: number }) {
  return <div className={`progress state-${state}`} role="progressbar" aria-label="book progress"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={state === 'finished' ? 100 : Math.round(progress * 100)}>
    <div style={{width: `${state === 'finished' ? 100 : Math.max(0, Math.min(100, progress * 100))}%`}}/>
  </div>;
}

export function ProgressGroup({ books, legend = false }: { books: Book[]; legend?: boolean }) {
  const group = ['finished', 'reading', 'paused', 'abandoned'] as const;
  const counts = group.map(state => books.filter(book => book.state === state).length);
  const total = books.length;
  return <div className="progress-group">
    <div className="progress segmented" role="img" aria-label={`${counts[0]} finished out of ${total} books`}>
      {group.map((state, i) => <div className={`state-${state}`} key={state} style={{width: `${total ? 100 * counts[i] / total : 0}%`}}/>)}
    </div>
    {legend && <div className="row legend">{group.map((state, i) => <span className={`state-pill state-${state}`} key={state}><i/>{counts[i]} {stateName[state]}</span>)}</div>}
  </div>;
}

export function Empty({ title, children, action, illustration = false }:
  {title: string; children?: ReactNode; action?: ReactNode; illustration?: boolean}) {
  return <div className={`empty-state ${illustration ? 'shelf-empty' : ''}`}>
    {illustration ? <div className="empty-illustration" aria-hidden="true">
      <div className="empty-back-book"/><div className="empty-front-book"><Mark size={84}/></div>
      <span className="empty-plus"><FolderPlus size={22}/></span><i/><i/>
    </div> : <CircleHelp aria-hidden="true" size={27}/>}
    <h2>{title}</h2>{children && <p>{children}</p>}{action}
  </div>;
}

export function Modal({ title, close, children, wide = false }: {title: string; close: () => void; children: ReactNode; wide?: boolean}) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} aria-labelledby={label} className={`deft-dialog ${wide ? 'wide' : ''}`}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === ref.current) close(); }}>
    <div className="dialog-body">
      <header><h2 id={label}>{title}</h2><button type="button" className="icon-button" aria-label="close dialog" onClick={close}><X size={19}/></button></header>
      {children}
    </div>
  </dialog>;
}

export function percent(value: number): string { return `${Math.round(value * 100)}%`; }
export function dateLabel(value?: number | null): string {
  return value != null ? new Date(value).toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'}) : '—';
}
export function dateInput(value?: number | null): string {
  if (value == null) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0,10);
}
export function inputDate(value: string): number | undefined { return value ? new Date(value + 'T12:00:00').getTime() : undefined; }
export function filesize(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
