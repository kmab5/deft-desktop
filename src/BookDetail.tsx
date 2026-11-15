import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Clock3, Download, Ellipsis, FileText, Heart, ImagePlus, Link2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { rpc, describeError } from './api';
import { BookBadges } from './Books';
import { localDay, duration, summarizeBook } from './statistics';
import { stateName, type Book, type BookState, type Edition, type ReadThrough, type Snapshot } from './types';
import { Cover, Modal, Progress, StatePill, dateInput, dateLabel, filesize, inputDate, percent } from './ui';

export type Act = (op: string, args?: Record<string, unknown>) => Promise<void>;
export type MatchEntry = { book: Book; candidates?: Edition[]; error?: string };
export const starRatings = Array.from({length:10}, (_, index) => (index + 1) / 2);
const outcomes = ['not_read', 'reading', 'paused', 'finished', 'abandoned'] as const;

export function Rating({ value, change, label = 'rating' }: { value?: number | null; change: (rating: number | null)=>void; label?: string }) {
  return <label className="rating-select"><Star size={17}/>
    <select value={value ?? ''} onChange={event => change(event.target.value ? Number(event.target.value) : null)} aria-label={label}>
      <option value="">no rating</option>
      {starRatings.map(rating => <option value={rating} key={rating}>{rating.toFixed(1)} / 5</option>)}
    </select>
  </label>;
}

export function StateDialog({ books, close, act }: { books: Book[]; close:()=>void; act:Act }) {
  const [outcome, setOutcome] = useState<BookState>(books.length === 1 ? books[0].state : 'reading');
  const [date, setDate] = useState(localDay());
  const [busy, setBusy] = useState(false);
  return <Modal title={books.length === 1 ? 'set reading state' : `set state · ${books.length} books`} close={close}>
    <form className="stack dialog-form" onSubmit={async event => {
      event.preventDefault();
      setBusy(true);
      try {
        const today = date === localDay();
        const timestamp = outcome === 'finished' ? today ? Date.now() : inputDate(date) : undefined;
        await act('bookState', {bookIds: books.map(book => book.id), outcome, date: timestamp,
          zoneOffsetMinutes: -new Date(timestamp ?? Date.now()).getTimezoneOffset()});
        close();
      } catch { setBusy(false); }
    }}>
      <div className="state-choices">
        {outcomes.map(value => <button className="button" type="button" key={value} aria-pressed={outcome === value} onClick={()=>setOutcome(value)}><StatePill state={value}/></button>)}
      </div>
      {outcome === 'not_read' && <p className="muted">Resets the reading position. Past sessions, notes, and finish dates stay in your history.</p>}
      {outcome === 'finished' && <label className="field">date finished<input type="date" required max={localDay()} value={date} onChange={event=>setDate(event.target.value)}/></label>}
      <div className="dialog-actions"><button type="button" className="button" onClick={close}>cancel</button><button className="button primary" disabled={busy}>save state</button></div>
    </form>
  </Modal>;
}

export function AddCategoryDialog({ data, books, close, act }: { data: Snapshot; books: Book[]; close:()=>void; act:Act }) {
  const [category, setCategory] = useState(data.categories[0]?.id ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title="add to a category" close={close}>
    <form className="stack dialog-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const id = category || (await rpc<{id:string}>('categoryCreate', {name})).id;
        await act('categoryMembership', {id, bookIds:books.map(book=>book.id), action:'add'});
        close();
      } catch (failure) { setError(describeError(failure)); setBusy(false); }
    }}>
      <label className="field">category<select value={category} onChange={event=>setCategory(event.target.value)}>
        <option value="">new category…</option>{data.categories.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>
      {!category && <label className="field">name<input required value={name} onChange={event=>setName(event.target.value)}/></label>}
      {error && <p className="error-copy" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button" onClick={close}>cancel</button><button className="button primary" disabled={busy}>add {books.length === 1 ? 'book' : 'books'}</button></div>
    </form>
  </Modal>;
}

export function MatchDialog({ entries, act, close, notice }: { entries: MatchEntry[]; act:Act; close:()=>void; notice:(message:string)=>void }) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const entry = entries[index];
  if (!entry) return null;
  async function select(edition?: Edition) {
    setBusy(true);
    try {
      if (edition) await act('matchConfirm', {bookId: entry.book.id, edition});
      if (edition) notice('Edition matched.');
      if (index + 1 < entries.length) setIndex(index + 1); else close();
    } catch { /* the operation displays the error */ }
    finally { setBusy(false); }
  }
  return <Modal title="match edition" close={close} wide>
    <p className="muted">{entry.book.title}{entries.length > 1 ? ` · ${index + 1} of ${entries.length}` : ''}</p>
    {entry.error && <p className="error-copy" role="alert">{entry.error}</p>}
    <div className="candidate-list">
      {entry.candidates?.map((candidate, offset) => <button key={offset} className="candidate" disabled={busy} onClick={() => {void select(candidate);}}>
        <span className="candidate-icon"><BookOpen size={20}/></span>
        <span><strong>{candidate.title}</strong><small>{[candidate.authors.join(', '),candidate.year,candidate.pages ? candidate.pages + ' pages' : undefined].filter(Boolean).join(' · ')}</small>
          <small className="mono">{[candidate.provider,candidate.isbn13 ?? candidate.isbn10].filter(Boolean).join(' · ')}</small></span>
        {candidate.exactIsbn && <span className="badge">exact ISBN</span>}<ArrowRight size={17}/>
      </button>)}
      {!entry.error && !entry.candidates?.length && <p>No editions matched this book.</p>}
    </div>
    <div className="dialog-actions"><button className="button" disabled={busy} onClick={() => {void select();}}>no match</button></div>
  </Modal>;
}

function MetadataDialog({ book, close, act }: { book:Book; close:()=>void; act:Act }) {
  const [title, setTitle] = useState(book.title);
  const [authors, setAuthors] = useState(book.authors.join('\n'));
  const [series, setSeries] = useState(book.series ?? '');
  const [index, setIndex] = useState(book.seriesIndex?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  async function apply(overrides: Record<string, unknown>) {
    setBusy(true);
    try { await act('bookPatch',{bookId:book.id,overrides}); close(); }
    catch { setBusy(false); }
  }
  return <Modal title="edit book details" close={close}>
    <form className="stack dialog-form" onSubmit={event => {
      event.preventDefault();
      void apply({title,authors:authors.split('\n').map(value=>value.trim()).filter(Boolean),series:series.trim(),seriesIndex:index ? Number(index) : null});
    }}>
      <label className="field">title<input value={title} required onChange={event => setTitle(event.target.value)}/></label>
      <label className="field">authors · one per line<textarea rows={3} value={authors} onChange={event => setAuthors(event.target.value)}/></label>
      <div className="filter-fields"><label className="field">series<input value={series} onChange={event => setSeries(event.target.value)}/></label>
        <label className="field">series position<input type="number" step="any" value={index} onChange={event => setIndex(event.target.value)}/></label></div>
      <div className="row wrap">
        <button type="button" className="button" onClick={() => {void act('bookCover',{bookId:book.id}).catch(()=>{});}}><ImagePlus size={16}/>choose cover</button>
        <button type="button" className="button quiet" onClick={() => {void apply({title:null,authors:null,series:null,seriesIndex:null,cover:null});}}>restore file metadata</button>
      </div>
      <div className="dialog-actions"><button type="button" className="button" onClick={close}>cancel</button><button className="button primary" disabled={busy}>save details</button></div>
    </form>
  </Modal>;
}

function RunDialog({ run, act, close }: { run:ReadThrough; act:Act; close:()=>void }) {
  const [start, setStart] = useState(dateInput(run.startedAt));
  const [end, setEnd] = useState(dateInput(run.endedAt));
  const [busy, setBusy] = useState(false);
  return <Modal title="edit read-through" close={close}>
    <form className="stack dialog-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true);
      try {
        await act('runEdit',{id:run.id,startedAt:inputDate(start),endedAt:inputDate(end) ?? null});
        close();
      } catch {setBusy(false);}
    }}>
      <label className="field">started<input type="date" required value={start} onChange={event=>setStart(event.target.value)}/></label>
      <label className="field">ended<input type="date" required={run.outcome === 'finished'} min={start} value={end} onChange={event=>setEnd(event.target.value)}/></label>
      <div className="dialog-actions"><button type="button" className="button" onClick={close}>cancel</button><button className="button primary" disabled={busy}>save dates</button></div>
    </form>
  </Modal>;
}

export function BookDetail({ book, data, back, read, openBook, openAuthor, openCategory, openNotes, act, notice, match }:
  {book:Book; data:Snapshot; back:()=>void; read:(book:Book)=>void; openBook:(book:Book)=>void;openAuthor:(id:string)=>void;
    openCategory:(id:string)=>void;openNotes:(id:string)=>void;act:Act;notice:(message:string)=>void;match:(ids:string[])=>Promise<void>}) {
  const [favoritePending, setFavoritePending] = useState<boolean>();
  const favorite = favoritePending ?? book.favorite;
  const [dialog, setDialog] = useState('');
  const [selectedRun, setRun] = useState<ReadThrough>();
  const [review, setReview] = useState(book.review);
  const [busy, setBusy] = useState(false);
  const stats = useMemo(() => summarizeBook(data, book.id), [book.id, data]);
  const history = data.readThroughs.filter(run => run.bookId === book.id).slice().reverse();
  const notes = data.annotations.filter(note=>note.bookId === book.id);
  const categories = data.categories.filter(category => category.members.some(member => member.bookId === book.id));
  const next = categories.filter(category=>category.typeIds.includes('series')).map(category => {
    const current = category.members.find(member => member.bookId === book.id)?.position ?? 0;
    return category.members.filter(member=>member.position > current)
      .sort((a,b)=>a.position-b.position).map(member=>data.books.find(entry=>entry.id === member.bookId))
      .find(entry=>entry && !entry.ignored && entry.state !== 'finished');
  }).find(Boolean);
  const patch = (values: Record<string, unknown>) => {void act('bookPatch',{bookId:book.id,...values}).catch(()=>{});};
  const wrapped = async (fn:()=>Promise<void>) => {setBusy(true);try {await fn();} catch {} finally {setBusy(false);}};
  const close = () => setDialog('');
  return <section className="screen detail-screen">
    <div className="detail-back"><button className="button quiet" onClick={back}><ArrowLeft size={17}/>back</button></div>
    <section className="book-hero panel">
      <Cover book={book}/>
      <div className="book-hero-body">
        <div className="row wrap"><span className="badge">{book.format.toUpperCase()}</span><StatePill state={book.state}/><BookBadges book={book}/></div>
        <h1>{book.title}</h1>
        {!!book.authors.length && <div className="row book-byline">{book.authors.map((author,index)=><button className="text-link" key={book.authorIds[index] ?? author} onClick={()=>openAuthor(book.authorIds[index])}>{author}</button>)}</div>}
        {book.series && <div className="mono muted">{book.series}{book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}</div>}
        <div className="book-hero-progress"><Progress state={book.state} progress={book.progress}/><span className="mono muted">
          {book.state === 'finished' ? '100%' : percent(book.progress)}{stats.estimateSeconds && book.state !== 'finished' ? ` · ${duration(stats.estimateSeconds)} left` : ''}
        </span></div>
        <div className="row wrap book-hero-actions">
          <button className="button primary" onClick={()=>read(book)}><BookOpen size={17}/>{book.progress > 0 && book.state !== 'finished' ? 'continue reading' : 'read'}</button>
          <button className="button" onClick={()=>setDialog('state')}>set state</button>
          <Rating value={book.rating} change={rating=>patch({rating})}/>
          <button className="icon-button framed" aria-label="favorite" aria-pressed={favorite} disabled={favoritePending !== undefined} onClick={() => {
            setFavoritePending(!favorite);
            void act('bookPatch', { bookId: book.id, favorite: !favorite }).catch(() => {}).finally(() => setFavoritePending(undefined));
          }}><Heart className={favorite ? 'favorite-icon' : ''} fill={favorite ? 'currentColor' : 'none'} size={19}/></button>
          <button className="icon-button framed" aria-label="book actions" onClick={()=>setDialog('actions')}><Ellipsis size={20}/></button>
        </div>
      </div>
    </section>
    <div className="detail-metrics">
      {[[duration(stats.activeSeconds),'reading time'],[stats.sessions,'sessions'],[stats.pagesPerHour ? `${Math.round(stats.pagesPerHour)} p/h` : '—','reading speed'],[stats.finished,'finishes']].map(([value,label])=>
        <div key={label} className="panel detail-metric"><span className="mono">{value}</span><span className="muted">{label}</span></div>)}
    </div>
    <div className="detail-columns">
      <div className="stack">
        <section className="panel detail-panel"><header><h2>read-throughs</h2><Clock3 size={17}/></header>
          {history.length ? history.map(run=><div key={run.id} className="detail-line">
            <div><StatePill state={run.outcome}/><span className="mono muted compact-line">{dateLabel(run.startedAt)}{run.endedAt ? ` → ${dateLabel(run.endedAt)}` : ''}</span></div>
            <div className="row"><button className="icon-button" aria-label="edit read-through dates" onClick={()=>{setRun(run);setDialog('run');}}><Pencil size={15}/></button>
              <button className="icon-button" aria-label="delete read-through" onClick={()=>{setRun(run);setDialog('deleteRun');}}><Trash2 size={16}/></button></div>
          </div>) : <p className="muted">Reading history will appear here.</p>}
          {data.sessions.some(session=>session.bookId === book.id) && <details className="session-history">
            <summary>sessions</summary>{data.sessions.filter(session=>session.bookId === book.id).slice().reverse().map(session=><div className="detail-line" key={session.id}>
              <span>{dateLabel(session.startedAt)}{session.browsing ? ' · browsing' : ''}</span><span className="mono muted">{duration(session.activeSeconds)}</span>
            </div>)}
          </details>}
        </section>
        <section className="panel detail-panel"><header><h2>categories</h2><button className="icon-button" aria-label="add to a category" onClick={()=>setDialog('category')}><Plus size={18}/></button></header>
          {categories.length ? categories.map(category=><button className="detail-line plain-line" key={category.id} onClick={()=>openCategory(category.id)}>
            <span>{category.name}</span><span className="mono muted">{category.typeIds.includes('series') ? `#${category.members.find(member=>member.bookId === book.id)?.position}` : ''}<ArrowRight size={14}/></span>
          </button>) : <p className="muted">This book has no categories.</p>}
          {next && <div className="next-book"><span className="mono muted">next in series</span><button className="text-link" onClick={()=>openBook(next)}>{next.title}<ArrowRight size={14}/></button></div>}
        </section>
        <section className="panel detail-panel"><header><h2>notes</h2><FileText size={17}/></header><p className="muted">{notes.length} {notes.length === 1 ? 'annotation' : 'annotations'}</p>
          <div className="row wrap"><button className="button" onClick={()=>openNotes(book.id)}>open notes<ArrowRight size={14}/></button><button className="button quiet" disabled={!notes.length} onClick={()=>{void act('exportToFile',{kind:'notes',bookId:book.id}).catch(()=>{});}}><Download size={15}/>export Markdown</button></div>
        </section>
      </div>
      <div className="stack">
        <section className="panel detail-panel"><header><h2>edition match</h2><Link2 size={17}/></header>
          {book.edition ? <div className="stack"><strong>{book.edition.title}</strong>
            <span className="muted">{[book.edition.provider,book.edition.isbn13 ?? book.edition.isbn10].filter(Boolean).join(' · ')}</span>
            <div className="row wrap">
              <button className="button" onClick={()=>{void act('matchMetadata',{bookId:book.id}).catch(()=>{});}}>use matched details</button>
              {book.edition.coverUrl && <button className="button" disabled={busy} onClick={()=>{void wrapped(()=>act('matchCover',{bookId:book.id}));}}>download cover</button>}
              <button className="button quiet" onClick={()=>{void act('matchConfirm',{bookId:book.id,edition:null}).catch(()=>{});}}>clear match</button>
            </div>
          </div> : <p className="muted">Find an edition to include this book in matched exports.</p>}
          <button className="button" disabled={busy} onClick={()=>{void wrapped(()=>match([book.id]));}}>{busy ? 'working…' : 'match edition'}</button>
        </section>
        <section className="panel detail-panel"><header><h2>review</h2><Pencil size={16}/></header>
          <form className="stack" onSubmit={event=>{event.preventDefault();void act('bookPatch',{bookId:book.id,review}).then(()=>notice('Review saved.')).catch(()=>{});}}>
            <textarea rows={3} aria-label="book review" placeholder="write a review" value={review} onChange={event => setReview(event.target.value)}/>
            <div><button className="button" disabled={review === book.review}>save review</button></div>
          </form>
        </section>
        <section className="panel detail-panel"><header><h2>file details</h2><FileText size={17}/></header>
          {book.metadata.description && <p className="book-description">{book.metadata.description.replace(/<[^>]*>/g, ' ')}</p>}
          <dl className="file-details">
            <div><dt>format</dt><dd>{book.format.toUpperCase()}</dd></div>
            {book.pageCount != null && <div><dt>pages</dt><dd>{book.pageCount}</dd></div>}
            {book.metadata.language && <div><dt>language</dt><dd>{book.metadata.language}</dd></div>}
            {book.metadata.publisher && <div><dt>publisher</dt><dd>{book.metadata.publisher}</dd></div>}
            {book.metadata.publishedDate && <div><dt>published</dt><dd>{book.metadata.publishedDate}</dd></div>}
            {(book.metadata.isbn13 ?? book.metadata.isbn10) && <div><dt>ISBN</dt><dd>{book.metadata.isbn13 ?? book.metadata.isbn10}</dd></div>}
          </dl>
          {book.files.map(file=><div className="file-path" key={file.path}><code>{file.path}</code><span className="mono muted">{filesize(file.size)}{file.missing ? ' · missing' : ''}</span></div>)}
        </section>
      </div>
    </div>
    {dialog === 'state' && <StateDialog books={[book]} close={close} act={act}/>}
    {dialog === 'category' && <AddCategoryDialog data={data} books={[book]} close={close} act={act}/>}
    {dialog === 'metadata' && <MetadataDialog book={book} close={close} act={act}/>}
    {dialog === 'run' && selectedRun && <RunDialog run={selectedRun} close={close} act={act}/>}
    {dialog === 'actions' && <Modal title="book actions" close={close}>
      <div className="stack">
        <button className="button" onClick={()=>setDialog('metadata')}><Pencil size={16}/>edit book details</button>
        <button className="button" onClick={()=>setDialog('ignore')}>ignore book</button>
        <button className="button danger" onClick={()=>setDialog('forget')}><Trash2 size={16}/>remove from Deft and forget history</button>
      </div>
    </Modal>}
    {['ignore','forget','deleteRun'].includes(dialog) && <Modal title={dialog === 'ignore' ? 'ignore this book?' : dialog === 'forget' ? 'forget this book?' : 'delete this read-through?'} close={close}>
      <p>{dialog === 'ignore' ? 'It disappears from your library and stats. You can bring it back in settings.' : dialog === 'forget' ? 'Its history, notes and rating will be deleted for good.' : 'The sessions recorded in this read-through will be deleted.'}</p>
      <div className="dialog-actions"><button className="button" onClick={close}>keep</button><button className="button danger" disabled={busy} onClick={()=>{void wrapped(async()=>{
        if (dialog === 'ignore') await act('bookPatch',{bookId:book.id,ignored:true});
        else if (dialog === 'forget') await act('bookForget',{bookId:book.id});
        else if (selectedRun) await act('runDelete',{id:selectedRun.id});
        close(); if (dialog !== 'deleteRun') back();
      });}}>{dialog === 'ignore' ? 'ignore' : 'delete'}</button></div>
    </Modal>}
  </section>;
}

export async function gatherMatches(books: Book[], report: (message:string)=>void): Promise<MatchEntry[]> {
  const review: MatchEntry[] = [];
  for (let i=0; i<books.length; i++) {
    const book = books[i];
    if (books.length > 1) report(`matching editions · ${i + 1} of ${books.length}`);
    try {
      const candidates = await rpc<Edition[]>('matchCandidates',{bookId:book.id});
      const exact = candidates.filter(candidate=>candidate.exactIsbn);
      if (books.length > 1 && exact.length === 1) await rpc('matchConfirm',{bookId:book.id,edition:exact[0]});
      else review.push({book,candidates});
    } catch (error) { review.push({book,error:describeError(error)}); }
  }
  return review;
}
