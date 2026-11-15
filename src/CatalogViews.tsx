import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bookmark, Check, Download, FolderPlus,
  GripVertical, Highlighter, ImagePlus, LibraryBig, Merge, NotebookPen, Pencil, Plus,
  Search, Star, Tags, Trash2,
} from 'lucide-react';
import { BookBadges } from './Books';
import { describeError } from './api';
import { Collage, Cover, Empty, Modal, ProgressGroup, StatePill, dateLabel } from './ui';
import { duration, summarizeBooks } from './statistics';
import { stateName } from './types';
import type { Annotation, Book, Category, CategoryType, Locator, Member, Snapshot } from './types';
import './catalog-views.css';

type Props = {
  data: Snapshot;
  act: (op: string, args?: Record<string, unknown>) => Promise<void>;
  notice: (message: string) => void;
  openBook: (book: Book) => void;
  read: (book: Book, jump?: Locator) => void;
};

const sortText = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const ratingOptions = Array.from({ length: 10 }, (_, i) => (i + 1) / 2);
const searchable = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
const tally = (n: number, singular: string, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;

function catalogs(data: Snapshot) {
  return new Map(data.books.filter(book => !book.ignored).map(book => [book.id, book]));
}

function categoryBooks(category: Category, byId: Map<string, Book>) {
  return category.members.flatMap(member => {
    const book = byId.get(member.bookId);
    return book ? [book] : [];
  });
}

function starAverage(books: Book[]) {
  let total = 0;
  let rated = 0;
  for (const book of books) if (book.rating != null && book.rating > 0) { total += book.rating; rated++; }
  return rated ? total / rated : undefined;
}

function Rating({ value, own = false }: { value?: number | null; own?: boolean }) {
  return <span className="catalog-rating mono"><Star size={14} aria-hidden />
    {value != null ? `${value.toFixed(1)}${own ? ' · yours' : ''}` : 'unrated'}
  </span>;
}

function SectionHeader({ title, back, actions }: { title: string; back?: () => void; actions?: React.ReactNode }) {
  return <header className="catalog-heading">
    <div>{back && <button className="button quiet catalog-back" type="button" onClick={back}><ArrowLeft size={16} aria-hidden /> back</button>}
      <h1>{title}</h1></div>
    {actions && <div className="catalog-actions">{actions}</div>}
  </header>;
}

function SearchField({ value, change, label }: { value: string; change: (text: string) => void; label: string }) {
  return <label className="catalog-search"><Search size={17} aria-hidden />
    <input aria-label={label} placeholder={label} type="search" value={value} onChange={e => change(e.target.value)} />
  </label>;
}

function CategoryEditor({ initial, types, close, save }: {
  initial?: Category; types: CategoryType[]; close: () => void;
  save: (args: { name: string; description: string; typeIds: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [typeIds, setTypeIds] = useState(initial?.typeIds ?? []);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    try { await save({ name: name.trim(), description: description.trim(), typeIds }); close(); }
    catch (error) { setMessage(describeError(error)); }
    finally { setSaving(false); }
  }
  return <Modal title={initial ? 'edit category' : 'new category'} close={close}>
    <form className="catalog-form" onSubmit={e => void submit(e)}>
      <label>name<input type="text" required maxLength={120} autoFocus value={name} onChange={e => setName(e.target.value)} /></label>
      <label>description<textarea rows={3} maxLength={1_000} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <fieldset><legend>types</legend><div className="catalog-actions">{types.map(type => <label key={type.id} className="catalog-type-toggle">
        <input type="checkbox" checked={typeIds.includes(type.id)} onChange={e => setTypeIds(current =>
          e.target.checked ? [...current, type.id] : current.filter(id => id !== type.id))} />{type.name}
      </label>)}</div></fieldset>
      {message && <p className="catalog-error" role="alert">{message}</p>}
      <div className="catalog-actions catalog-end"><button type="button" className="button quiet" onClick={close}>cancel</button>
        <button type="submit" className="button primary" disabled={saving || !name.trim()}>{initial ? 'save category' : 'create category'}</button></div>
    </form>
  </Modal>;
}

function Confirm({ title, text, action, close }: { title: string; text: string; action: () => Promise<void>; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title={`${title}?`} close={close}>
    <div className="catalog-form"><p>{text}</p>{error && <p className="catalog-error" role="alert">{error}</p>}
      <div className="catalog-actions catalog-end">
        <button type="button" className="button quiet" onClick={close}>cancel</button>
        <button type="button" className="button primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await action(); close(); } catch (failure) { setError(describeError(failure)); }
          finally { setBusy(false); }
        }}>{title}</button>
      </div></div>
  </Modal>;
}

function MergeDialog({ label, source, choices, action, close }: {
  label: 'category' | 'author'; source: string; choices: { id: string; name: string; hint?: string }[];
  action: (id: string) => Promise<void>; close: () => void;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title={`merge ${label}`} close={close}>
    <form className="catalog-form" onSubmit={async e => {
      e.preventDefault();
      if (busy || !target) return;
      setBusy(true);
      try { await action(target); close(); } catch (failure) { setError(describeError(failure)); }
      finally { setBusy(false); }
    }}>
      <p>{label === 'category' ? 'The receiving category keeps its order and rating.' : 'The receiving author keeps their name. Both entries’ books appear under it.'}</p>
      <div className="catalog-actions"><span className="muted">from</span><strong>{source}</strong></div>
      <label>into<select value={target} onChange={e => setTarget(e.target.value)} required>
        <option value="" disabled>choose a {label}</option>{choices.map(({ id, name, hint }) =>
          <option key={id} value={id}>{name}{hint ? ` · ${hint}` : ''}</option>)}
      </select></label>
      {error && <p className="catalog-error" role="alert">{error}</p>}
      <div className="catalog-actions catalog-end"><button type="button" className="button quiet" onClick={close}>cancel</button>
        <button type="submit" className="button primary" disabled={!target || busy}>merge {label}</button></div>
    </form>
  </Modal>;
}

function TypeManager({ data, act, close }: Pick<Props, 'data' | 'act'> & { close: () => void }) {
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<string>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    await change('typeSave', { id: edit, name: name.trim() }, () => { setName(''); setEdit(undefined); });
  };
  async function change(op: string, args: Record<string, unknown>, done: () => void) {
    setBusy(true); setMessage('');
    try { await act(op, args); done(); } catch (error) { setMessage(describeError(error)); }
    finally { setBusy(false); }
  }
  return <Modal title="category types" close={close}>
    <div className="catalog-form">
      {data.types.map(type => <div className="catalog-type-row" key={type.id}>
        <strong>{type.name}</strong>
        {type.builtIn ? <span className="muted mono">built in</span> : remove === type.id
          ? <><button className="button quiet" onClick={() => setRemove(undefined)}>keep</button>
            <button className="button" disabled={busy} onClick={() => void change('typeDelete', { id: type.id }, () => {
              setRemove(undefined);
              if (edit === type.id) { setEdit(undefined); setName(''); }
            })}>delete type</button></>
          : <><button className="icon-button" aria-label={`rename ${type.name} type`} onClick={() => { setEdit(type.id); setName(type.name); }}><Pencil size={15} /></button>
            <button className="icon-button" aria-label={`delete ${type.name} type`} onClick={() => setRemove(type.id)}><Trash2 size={15} /></button></>}
      </div>)}
      <form className="catalog-form catalog-type-form" onSubmit={e => void save(e)}>
        <label>{edit ? 'rename type' : 'new type'}<input type="text" value={name} required maxLength={60} onChange={e => setName(e.target.value)} /></label>
        <div className="catalog-actions catalog-end">
          {edit && <button type="button" className="button quiet" onClick={() => { setEdit(undefined); setName(''); }}>cancel edit</button>}
          <button type="submit" className="button primary" disabled={!name.trim() || busy}>{edit ? 'save type' : 'add type'}</button>
        </div>
      </form>
      {message && <p className="catalog-error" role="alert">{message}</p>}
    </div>
  </Modal>;
}

function AddMembers({ books, category, add, close }: {
  books: Book[]; category: Category; add: (ids: string[]) => Promise<void>; close: () => void;
}) {
  const [query, setQuery] = useState('');
  const [marked, setMarked] = useState<string[]>([]);
  const [limit, setLimit] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = useMemo(() => {
    const members = new Set(category.members.map(member => member.bookId));
    return books.filter(book => !book.ignored && !members.has(book.id)).sort((a, b) => sortText.compare(a.title, b.title));
  }, [books, category.members]);
  const matches = choices.filter(book => searchable([book.title, ...book.authors].join(' ')).includes(searchable(query.trim())));
  return <Modal title="add books" close={close} wide>
    <div className="catalog-form">
      <SearchField value={query} change={text => { setQuery(text); setLimit(120); }} label="search books" />
      <div className="catalog-picker">
        {matches.slice(0, limit).map(book => <label key={book.id}>
          <input type="checkbox" checked={marked.includes(book.id)} onChange={e => setMarked(current =>
            e.target.checked ? [...current, book.id] : current.filter(id => id !== book.id))} />
          <span><strong>{book.title}</strong><span className="muted">{book.authors.join(', ')}</span></span>
          <BookBadges book={book} />
        </label>)}
        {!matches.length && <p className="muted">No books to add.</p>}
        {matches.length > limit && <button type="button" className="button quiet" onClick={() => setLimit(n => n + 120)}>show more</button>}
      </div>
      {error && <p className="catalog-error" role="alert">{error}</p>}
      <div className="catalog-actions catalog-end"><span className="mono muted">{marked.length} selected</span>
        <button className="button primary" type="button" disabled={!marked.length || busy} onClick={async () => {
          setBusy(true);
          try { await add(marked); close(); } catch (failure) { setError(describeError(failure)); }
          finally { setBusy(false); }
        }}>add selected</button></div>
    </div>
  </Modal>;
}

function sortMembers(category: Category, byId: Map<string, Book>) {
  const series = category.typeIds.includes('series');
  const ordered = [...category.members].sort((a, b) => {
    const first = byId.get(a.bookId);
    const second = byId.get(b.bookId);
    if (series || category.orderMode === 'manual') return a.position - b.position || a.addedAt - b.addedAt;
    const title = sortText.compare(first?.title ?? '', second?.title ?? '');
    if (category.orderMode === 'author') return sortText.compare(first?.authors[0] ?? '', second?.authors[0] ?? '') || title;
    if (category.orderMode === 'added') return b.addedAt - a.addedAt || title;
    if (category.orderMode === 'rating') return (second?.rating ?? 0) - (first?.rating ?? 0) || title;
    return title;
  });
  return category.sortReversed && !series && category.orderMode !== 'manual' ? ordered.reverse() : ordered;
}

function PositionEditor({ member, title, save, close }: { member: Member; title: string; save: (position: number) => Promise<void>; close: () => void }) {
  const [value, setValue] = useState(String(member.position));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="series position" close={close}><form className="catalog-form" onSubmit={async e => {
    e.preventDefault(); if (busy || !value.trim() || !Number.isFinite(Number(value))) return;
    setBusy(true);
    try { await save(Number(value)); close(); } catch (failure) { setError(describeError(failure)); }
    finally { setBusy(false); }
  }}>
    <p>{title}</p><label>position<input type="number" step="any" value={value} autoFocus required onChange={e => setValue(e.target.value)} /></label>
    {error && <p className="catalog-error" role="alert">{error}</p>}
    <div className="catalog-actions catalog-end"><button className="button primary" disabled={busy} type="submit">save position</button></div>
  </form></Modal>;
}

function CategoryPage({ category, byId, data, act, openCategory, openBook, notice }: {
  category: Category; byId: Map<string, Book>; openCategory: (id?: string) => void;
} & Pick<Props, 'data' | 'act' | 'openBook' | 'notice'>) {
  const [dialog, setDialog] = useState<'edit' | 'delete' | 'merge' | 'add'>();
  const [editingPosition, setEditingPosition] = useState<Member>();
  const [dragged, setDragged] = useState<string>();
  const [targetDrag, setTargetDrag] = useState<string>();
  const [limit, setLimit] = useState(120);
  const [busy, setBusy] = useState(false);
  const members = sortMembers(category, byId);
  const visible = members.filter(member => byId.has(member.bookId));
  const series = category.typeIds.includes('series');
  const manual = !series && category.orderMode === 'manual';
  const books = categoryBooks(category, byId);
  const summary = summarizeBooks(data, books.map(book => book.id));
  const suggested = visible.filter(member => member.suggested);
  const choices = data.categories.filter(other => other.id !== category.id).sort((a, b) => sortText.compare(a.name, b.name));
  const types = data.types.filter(type => category.typeIds.includes(type.id));
  const patch = (args: Record<string, unknown>) => act('categoryPatch', { id: category.id, ...args });
  const membership = (action: 'add' | 'edit' | 'remove', bookIds: string[], position?: number) =>
    act('categoryMembership', { id: category.id, action, bookIds, ...(position == null ? {} : { position }) });
  async function quick(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); } catch (error) { notice(describeError(error)); }
    finally { setBusy(false); }
  }
  function reorder(from: string, into: string) {
    if (from === into) return;
    const ids = members.map(member => member.bookId);
    const destination = ids.indexOf(into);
    const source = ids.indexOf(from);
    if (destination < 0 || source < 0) return;
    ids.splice(source, 1);
    ids.splice(destination, 0, from);
    void quick(() => act('categoryOrder', { id: category.id, ids }));
  }
  return <div className="catalog-page">
    <SectionHeader title={category.name} back={() => openCategory()} actions={<>
      <button className="button quiet" onClick={() => setDialog('edit')}><Pencil size={16} aria-hidden /> edit</button>
      <button className="button primary" onClick={() => setDialog('add')}><Plus size={17} aria-hidden /> add books</button>
    </>} />
    <section className="panel catalog-category-head">
      <Collage category={category} books={books} />
      <div className="catalog-category-info">
        {types.length > 0 && <div className="catalog-tags">{types.map(kind => <span className="badge" key={kind.id}>{kind.name}</span>)}</div>}
        {category.description && <p>{category.description}</p>}
        <div className="catalog-actions"><strong className="mono">{summary.finished} / {summary.total} finished</strong>
          {suggested.length > 0 && <span className="catalog-review mono"><i /> {tally(suggested.length, 'suggestion')}</span>}</div>
        <ProgressGroup books={books} legend />
        <div className="catalog-category-numbers">
          <span><strong className="mono">{duration(summary.activeSeconds)}</strong><span className="muted">time read</span></span>
          <span><Rating value={category.rating ?? summary.rating} own={category.rating != null} /><span className="muted">{category.rating == null ? 'computed rating' : 'rating override'}</span></span>
          <label>rate category<select aria-label="rate category" value={category.rating ?? ''} disabled={busy} onChange={e => void quick(() =>
            patch({ rating: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">computed average</option>{ratingOptions.map(rating => <option key={rating} value={rating}>{rating.toFixed(1)} stars</option>)}
          </select></label>
        </div>
      </div>
    </section>

    <div className="catalog-actions catalog-manage">
      <button className="button quiet" disabled={busy} onClick={() => void quick(() => act('categoryCover', { id: category.id }))}><ImagePlus size={16} aria-hidden /> change cover</button>
      {category.cover && <button className="button quiet" disabled={busy} onClick={() => void quick(() => patch({ clearCover: true }))}>use collage</button>}
      <button className="button quiet" disabled={!choices.length} onClick={() => setDialog('merge')}><Merge size={16} aria-hidden /> merge</button>
      <button className="button quiet" onClick={() => setDialog('delete')}><Trash2 size={16} aria-hidden /> delete category</button>
    </div>

    <section className="panel catalog-member-section">
      <header><h2>{series ? 'series order' : 'books'}</h2><div className="catalog-actions">
        {suggested.length > 0 && <button className="button quiet" disabled={busy}
          onClick={() => void quick(() => membership('edit', suggested.map(member => member.bookId)))}><Check size={16} aria-hidden /> confirm suggestions</button>}
        {!series && <label className="catalog-sort">order<select aria-label="order" value={category.orderMode} disabled={busy} onChange={e => void quick(() => patch({ orderMode: e.target.value }))}>
          <option value="manual">manual</option><option value="title">title</option><option value="author">author</option>
          <option value="added">date added</option><option value="rating">rating</option>
        </select></label>}
        {!series && !manual && <button type="button" className="icon-button framed" aria-label="reverse category sort order"
          aria-pressed={Boolean(category.sortReversed)} title="reverse category sort order" disabled={busy}
          onClick={() => void quick(() => patch({ sortReversed: !category.sortReversed }))}>
          {category.sortReversed ? <ArrowUp size={17} /> : <ArrowDown size={17} />}
        </button>}
      </div></header>
      {!visible.length && <Empty title="no books in this category.">Choose books from your library to fill it.</Empty>}
      {visible.length > 0 && <ol className="catalog-members">
        {visible.slice(0, limit).map((member, index) => {
          const book = byId.get(member.bookId)!;
          return <li className="catalog-member" data-drag-over={targetDrag === book.id} key={book.id} onDragOver={e => {
            if (manual && dragged && dragged !== book.id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setTargetDrag(book.id); }
          }} onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setTargetDrag(undefined); }}
            onDrop={e => { e.preventDefault(); if (dragged) reorder(dragged, book.id); setDragged(undefined); setTargetDrag(undefined); }}>
            {manual && <button className="icon-button catalog-handle" draggable={!busy} type="button"
              aria-label={`drag to reorder ${book.title}`} title="drag to reorder" onDragStart={e => {
                e.dataTransfer.setData('text/plain', book.id); e.dataTransfer.effectAllowed = 'move'; setDragged(book.id);
              }} onDragEnd={() => { setDragged(undefined); setTargetDrag(undefined); }}><GripVertical size={16} aria-hidden /></button>}
            {series && <button className="button quiet catalog-position mono" aria-label={`edit position for ${book.title}`} type="button"
              onClick={() => setEditingPosition(member)}>#{member.position}</button>}
            <button className="catalog-book-link" type="button" onClick={() => openBook(book)}><Cover book={book} />
              <span><strong>{book.title}</strong><span className="muted">{book.authors.join(', ')}</span><BookBadges book={book} /></span>
            </button>
            <StatePill state={book.state} />
            <div className="catalog-actions catalog-member-actions">
              {member.suggested && <button className="icon-button catalog-review" type="button" disabled={busy} title="confirm suggested book"
                aria-label={`confirm suggested book ${book.title}`} onClick={() => void quick(() => membership('edit', [book.id]))}><Check size={16} /></button>}
              {manual && <>
                <button className="icon-button" type="button" disabled={busy || index === 0} aria-label={`move ${book.title} up`}
                  onClick={() => reorder(book.id, visible[index - 1].bookId)}><ArrowUp size={15} /></button>
                <button className="icon-button" type="button" disabled={busy || index === visible.length - 1} aria-label={`move ${book.title} down`}
                  onClick={() => reorder(book.id, visible[index + 1].bookId)}><ArrowDown size={15} /></button>
              </>}
              <button className="icon-button" type="button" disabled={busy} aria-label={`remove ${book.title} from category`}
                onClick={() => void quick(() => membership('remove', [book.id]))}><Trash2 size={15} /></button>
            </div>
          </li>;
        })}
      </ol>}
      {visible.length > limit && <button type="button" className="button quiet" onClick={() => setLimit(n => n + 120)}>show more</button>}
    </section>

    {dialog === 'edit' && <CategoryEditor initial={category} types={data.types} close={() => setDialog(undefined)} save={patch} />}
    {dialog === 'add' && <AddMembers books={data.books} category={category} close={() => setDialog(undefined)} add={ids => membership('add', ids)} />}
    {dialog === 'delete' && <Confirm title="delete category" text="The category and its memberships will be removed. Books and reading history stay in your library."
      close={() => setDialog(undefined)} action={async () => { await act('categoryDelete', { id: category.id }); openCategory(); }} />}
    {dialog === 'merge' && <MergeDialog label="category" source={category.name} choices={choices.map(other => ({
      id: other.id, name: other.name, hint: tally(categoryBooks(other, byId).length, 'book'),
    }))} close={() => setDialog(undefined)} action={async target => { await act('categoryMerge', { source: category.id, target }); openCategory(target); }} />}
    {editingPosition && <PositionEditor member={editingPosition} title={byId.get(editingPosition.bookId)?.title ?? ''} close={() => setEditingPosition(undefined)}
      save={position => membership('edit', [editingPosition.bookId], position)} />}
  </div>;
}

export function Categories({ data, act, categoryId, openCategory, openBook, notice }: Props & {
  categoryId?: string;
  openCategory: (id?: string) => void;
}) {
  const [type, setType] = useState('');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'create' | 'types'>();
  const [limit, setLimit] = useState(120);
  const byId = useMemo(() => catalogs(data), [data.books]);
  const types = useMemo(() => new Map(data.types.map(kind => [kind.id, kind.name])), [data.types]);
  const category = data.categories.find(candidate => candidate.id === categoryId);
  useEffect(() => { if (type && !types.has(type)) setType(''); }, [types, type]);
  const filtered = data.categories.filter(item => (!type || item.typeIds.includes(type)) &&
    searchable(`${item.name} ${item.description}`).includes(searchable(query.trim())))
    .sort((a, b) => sortText.compare(a.name, b.name) || a.createdAt - b.createdAt);
  if (category) return <CategoryPage key={category.id} {...{ category, byId, data, act, openCategory, openBook, notice }} />;
  return <div className="catalog-page">
    <SectionHeader title="categories" actions={<>
      <button className="button quiet" onClick={() => setDialog('types')}><Tags size={17} aria-hidden /> types</button>
      <button className="button primary" onClick={() => setDialog('create')}><Plus size={17} aria-hidden /> new category</button>
    </>} />
    <div className="catalog-filterline">
      <div className="catalog-actions" aria-label="Filter categories by type">
        <button className="button" aria-pressed={!type} onClick={() => { setType(''); setLimit(120); }}>all types</button>
        {data.types.map(kind => <button className="button" key={kind.id} aria-pressed={type === kind.id}
          onClick={() => { setType(current => current === kind.id ? '' : kind.id); setLimit(120); }}>{kind.name}</button>)}
      </div>
      <SearchField value={query} change={text => { setQuery(text); setLimit(120); }} label="search categories" />
    </div>
    {filtered.length === 0 ? <Empty title={data.categories.length ? 'no matching categories.' : 'no categories yet.'}
      action={!data.categories.length && <button className="button primary" onClick={() => setDialog('create')}><FolderPlus size={17} aria-hidden /> new category</button>}>
      {data.categories.length ? 'Choose another type or search.' : 'Group books into a series, a reading list, or a collection of your own.'}
    </Empty> : <div className="catalog-category-grid">
      {filtered.slice(0, limit).map(item => {
        const books = categoryBooks(item, byId);
        const finished = books.filter(book => book.state === 'finished').length;
        const suggested = item.members.some(member => member.suggested && byId.has(member.bookId));
        return <button className="panel catalog-category-card" type="button" key={item.id} onClick={() => openCategory(item.id)}>
          <Collage category={item} books={books} />
          <span className="catalog-category-card-content">
            <strong>{item.name}</strong>
            <span className="catalog-tags">{item.typeIds.map(id => types.has(id) && <span className="badge" key={id}>{types.get(id)}</span>)}</span>
            <span className="catalog-actions muted mono">{finished} / {books.length} finished
              {suggested && <span className="catalog-review"><i /> review</span>}</span>
            <ProgressGroup books={books} />
            <Rating value={item.rating ?? starAverage(books)} own={item.rating != null} />
          </span>
        </button>;
      })}
    </div>}
    {filtered.length > limit && <button className="button quiet" onClick={() => setLimit(n => n + 120)}>show more categories</button>}
    {dialog === 'create' && <CategoryEditor types={data.types} close={() => setDialog(undefined)} save={args => act('categoryCreate', args)} />}
    {dialog === 'types' && <TypeManager data={data} act={act} close={() => setDialog(undefined)} />}
  </div>;
}

function RenameAuthor({ name, save, close }: { name: string; save: (name: string) => Promise<void>; close: () => void }) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="rename author" close={close}><form className="catalog-form" onSubmit={async e => {
    e.preventDefault(); const next = draft.trim(); if (!next || busy) return;
    setBusy(true);
    try { await save(next); close(); } catch (failure) { setError(describeError(failure)); }
    finally { setBusy(false); }
  }}>
    <label>author name<input type="text" required autoFocus maxLength={120} value={draft} onChange={e => setDraft(e.target.value)} /></label>
    {error && <p className="catalog-error" role="alert">{error}</p>}
    <div className="catalog-actions catalog-end"><button type="button" className="button quiet" onClick={close}>cancel</button>
      <button type="submit" className="button primary" disabled={busy || draft.trim() === name || !draft.trim()}>save author</button></div>
  </form></Modal>;
}

export function Authors({ data, act, authorId, openAuthor, openBook }: Props & {
  authorId?: string;
  openAuthor: (id?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(120);
  const [dialog, setDialog] = useState<'rename' | 'merge'>();
  const byId = useMemo(() => catalogs(data), [data.books]);
  const people = useMemo(() => data.authors.map(author => ({
    author, books: [...new Set(author.bookIds)].flatMap(id => {
      const book = byId.get(id);
      return book ? [book] : [];
    }),
  })).filter(person => person.books.length > 0).sort((a, b) => sortText.compare(a.author.name, b.author.name)), [data.authors, byId]);
  const selected = people.find(person => person.author.id === authorId);
  const visible = people.filter(person => searchable(person.author.name).includes(searchable(query.trim())));
  if (selected) {
    const { author, books } = selected;
    const summary = summarizeBooks(data, books.map(book => book.id));
    return <div className="catalog-page">
      <SectionHeader title={author.name} back={() => openAuthor()} actions={<>
        <button className="button quiet" onClick={() => setDialog('rename')}><Pencil size={16} aria-hidden /> rename</button>
        <button className="button quiet" disabled={people.length < 2} onClick={() => setDialog('merge')}><Merge size={16} aria-hidden /> merge</button>
      </>} />
      <section className="panel catalog-author-head">
        <div><h2>{summary.finished} / {summary.total} finished</h2><ProgressGroup books={books} legend /></div>
        <div className="catalog-category-numbers">
          <span><strong className="mono">{duration(summary.activeSeconds)}</strong><span className="muted">time read</span></span>
          <span><Rating value={summary.rating} /><span className="muted">average rating</span></span>
        </div>
      </section>
      {(['reading', 'finished', 'paused', 'abandoned', 'not_read'] as const).map(state => {
        const shelf = books.filter(book => book.state === state).sort((a, b) => sortText.compare(a.title, b.title));
        return shelf.length > 0 && <section className="panel catalog-author-shelf" key={state}>
          <header><h2>{stateName[state]}</h2><span className="muted mono">{shelf.length}</span></header>
          <div className="catalog-author-books">{shelf.map(book => <button type="button" className="catalog-author-book" key={book.id} onClick={() => openBook(book)}>
            <Cover book={book} /><strong title={book.title}>{book.title}</strong><BookBadges book={book} />
          </button>)}</div>
        </section>;
      })}
      {dialog === 'rename' && <RenameAuthor name={author.name} close={() => setDialog(undefined)} save={name => act('authorRename', { id: author.id, name })} />}
      {dialog === 'merge' && <MergeDialog label="author" source={author.name} choices={people.filter(person => person.author.id !== author.id).map(person => ({
        id: person.author.id, name: person.author.name, hint: tally(person.books.length, 'book'),
      }))} close={() => setDialog(undefined)} action={async target => { await act('authorMerge', { source: author.id, target }); openAuthor(target); }} />}
    </div>;
  }
  return <div className="catalog-page">
    <SectionHeader title="authors" actions={<SearchField value={query} change={text => { setQuery(text); setLimit(120); }} label="search authors" />} />
    {visible.length ? <div className="panel catalog-author-list">
      {visible.slice(0, limit).map(({ author, books }) => <button key={author.id} className="catalog-author-row" type="button" onClick={() => openAuthor(author.id)}>
        <span className="catalog-author-letter" aria-hidden>{Array.from(author.name)[0]?.toLocaleUpperCase() || '?'}</span>
        <span className="catalog-author-name"><strong>{author.name}</strong><span className="muted mono">{tally(books.length, 'book')} · {books.filter(book => book.state === 'finished').length} finished</span></span>
        <ProgressGroup books={books} /><ArrowRight size={17} aria-hidden />
      </button>)}
    </div> : <Empty title={people.length ? 'no matching authors.' : 'no authors yet.'}>
      {people.length ? 'Try another name.' : 'Author pages appear when books have author information.'}
    </Empty>}
    {visible.length > limit && <button type="button" className="button quiet" onClick={() => setLimit(n => n + 120)}>show more authors</button>}
  </div>;
}

const noteKind = { highlight: 'highlight', page: 'page note', bookmark: 'bookmark' } as const;
const noteColors = ['purple', 'green', 'amber', 'grey'] as const;
const normalizeColor = (color: string) => color === 'gray' || color === 'neutral' ? 'grey' : color;
function notePosition(note: Annotation) {
  return note.locator.page != null ? `page ${note.locator.page + 1}` : `chapter ${note.locator.chapter + 1}`;
}

function NoteEditor({ initial, close, save }: { initial: Annotation; close: () => void; save: (note: Annotation) => Promise<void> }) {
  const [note, setNote] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bookmark = note.kind === 'bookmark';
  return <Modal title={`edit ${noteKind[note.kind]}`} close={close}><form className="catalog-form" onSubmit={async e => {
    e.preventDefault(); if (busy) return;
    setBusy(true);
    try { await save(note); close(); } catch (failure) { setError(describeError(failure)); }
    finally { setBusy(false); }
  }}>
    {note.kind === 'highlight' && note.text && <blockquote>{note.text}</blockquote>}
    {bookmark ? <label>label<input value={note.text} type="text" required maxLength={250} onChange={e => setNote({ ...note, text: e.target.value })} autoFocus /></label>
      : <label>note<textarea aria-label="note" value={note.note} rows={5} maxLength={10_000} required={note.kind === 'page'}
        onChange={e => setNote({ ...note, note: e.target.value })} autoFocus /></label>}
    {note.kind === 'highlight' && <fieldset><legend>highlight color</legend><div className="catalog-actions">
      {noteColors.map(color => <button type="button" key={color} className="catalog-color-button" data-color={color}
        aria-pressed={normalizeColor(note.color) === color} aria-label={color} onClick={() => setNote({ ...note, color })}><i />{color}</button>)}
    </div></fieldset>}
    {error && <p className="catalog-error" role="alert">{error}</p>}
    <div className="catalog-actions catalog-end"><button type="button" className="button quiet" onClick={close}>cancel</button>
      <button type="submit" className="button primary" disabled={busy}>save</button></div>
  </form></Modal>;
}

export function Notes({ data, act, read, openBook, notice, bookId, setBookId }: Props & {
  bookId?: string;
  setBookId: (id?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Annotation['kind'] | ''>('');
  const [color, setColor] = useState('');
  const [limit, setLimit] = useState(120);
  const [editing, setEditing] = useState<Annotation>();
  const [removing, setRemoving] = useState<Annotation>();
  const [exporting, setExporting] = useState(false);
  const byId = useMemo(() => catalogs(data), [data.books]);
  const noteBook = bookId ? byId.get(bookId) : undefined;
  const books = useMemo(() => [...new Set(data.annotations.map(note => note.bookId))].flatMap(id => {
    const book = byId.get(id);
    return book ? [book] : [];
  }).sort((a, b) => sortText.compare(a.title, b.title)), [data.annotations, byId]);
  const notes = useMemo(() => data.annotations.filter(note => {
    const book = byId.get(note.bookId);
    return book && (!bookId || bookId === note.bookId) && (!kind || note.kind === kind) &&
      (!color || note.kind === 'highlight' && normalizeColor(note.color) === color) &&
      (!query.trim() || searchable([note.text, note.note, book.title, ...book.authors].join(' ')).includes(searchable(query.trim())));
  }).sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt), [data.annotations, byId, bookId, kind, color, query]);
  useEffect(() => setLimit(120), [bookId, kind, color, query]);
  return <div className="catalog-page catalog-notes">
    <SectionHeader title="notes" actions={<>
      <SearchField value={query} change={setQuery} label="search notes" />
      {noteBook && <button className="button" disabled={exporting} onClick={async () => {
        setExporting(true);
        try { await act('exportToFile', { kind: 'notes', bookId: noteBook.id }); } catch (failure) { notice(describeError(failure)); }
        finally { setExporting(false); }
      }}><Download size={16} aria-hidden /> export markdown</button>}
    </>} />
    <div className="catalog-filterline">
      <label className="catalog-sort">book<select aria-label="book" value={noteBook?.id ?? ''} onChange={e => setBookId(e.target.value || undefined)}>
        <option value="">all books</option>
        {noteBook && !books.some(book => book.id === noteBook.id) && <option value={noteBook.id}>{noteBook.title}</option>}
        {books.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}
      </select></label>
      <label className="catalog-sort">type<select aria-label="type" value={kind} onChange={e => {
        const next = e.target.value as Annotation['kind'] | '';
        setKind(next);
        if (next && next !== 'highlight') setColor('');
      }}>
        <option value="">all types</option><option value="highlight">highlights</option><option value="bookmark">bookmarks</option><option value="page">page notes</option>
      </select></label>
      <label className="catalog-sort">color<select aria-label="color" value={color} onChange={e => setColor(e.target.value)} disabled={Boolean(kind && kind !== 'highlight')}>
        <option value="">all colors</option>{noteColors.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {noteBook && <button type="button" className="button quiet" onClick={() => openBook(noteBook)}><LibraryBig size={16} aria-hidden /> book details</button>}
    </div>
    {!notes.length && <Empty title={data.annotations.length && (query || color || kind) ? 'no matching notes.' : 'nothing highlighted yet.'}>
      {query || color || kind ? 'Try another search or filter.' : 'Select a passage while reading to highlight it or add a note.'}
    </Empty>}
    {notes.slice(0, limit).map(note => {
      const book = byId.get(note.bookId)!;
      const Icon = note.kind === 'highlight' ? Highlighter : note.kind === 'bookmark' ? Bookmark : NotebookPen;
      return <article className="panel catalog-note" data-color={normalizeColor(note.color)} key={note.id}>
        <header><span className="catalog-actions mono muted"><Icon size={15} aria-hidden /> {noteKind[note.kind]} · {dateLabel(note.createdAt)}</span>
          <div className="catalog-actions">
            <button type="button" className="icon-button" aria-label="edit annotation" onClick={() => setEditing(note)}><Pencil size={15} /></button>
            <button type="button" className="icon-button" aria-label="delete annotation" onClick={() => setRemoving(note)}><Trash2 size={15} /></button>
          </div>
        </header>
        {note.kind === 'highlight' && note.text && <blockquote>{note.text}</blockquote>}
        {note.kind === 'bookmark' && <strong>{note.text || 'bookmark'}</strong>}
        {note.note && <p>{note.note}</p>}
        <footer>
          <button type="button" className="catalog-note-source" onClick={() => openBook(book)} title={book.title}>{book.title}</button>
          <span className="mono muted">{notePosition(note)}</span>
          <BookBadges book={book} />
          {!book.missing && !book.protected && <button type="button" className="button quiet" onClick={() => read(book, note.locator)}>open in reader <ArrowRight size={16} aria-hidden /></button>}
        </footer>
      </article>;
    })}
    {notes.length > limit && <button className="button quiet" onClick={() => setLimit(n => n + 120)}>show more notes</button>}
    {editing && <NoteEditor initial={editing} close={() => setEditing(undefined)} save={annotation => act('noteSave', { annotation })} />}
    {removing && <Confirm title={`delete ${noteKind[removing.kind]}`} text="This annotation will be removed from your notes and the reader."
      close={() => setRemoving(undefined)} action={() => act('noteDelete', { id: removing.id })} />}
  </div>;
}
