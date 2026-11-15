import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowDownWideNarrow, ArrowRight, ArrowUp, BookOpen, Check, FolderPlus, Grid2X2, Heart, List, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { formats, stateName, type Book, type BookState, type Snapshot } from './types';
import { Cover, Empty, Modal, Progress, StatePill, percent } from './ui';

type Filters = { state: BookState | ''; format: string; category: string; rating: string; favorite: boolean; missing: boolean; hideProtected: boolean; matched: boolean };
const defaults: Filters = { state: '', format: '', category: '', rating: '', favorite: false, missing: false, hideProtected: false, matched: false };
const sorts = { recent:'recently read', title:'title', author:'author', added:'date added', rating:'rating', progress:'progress' } as const;
type Sort = keyof typeof sorts;
const pageSize = 96;
const collator = new Intl.Collator(undefined, {numeric:true,sensitivity:'base'});

export function BookBadges({ book }: { book: Book }) {
  return <span className="book-badges">
    {book.missing && <span className="badge">file missing</span>}
    {book.protected && <span className="badge warning">protected</span>}
    {book.favorite && <Heart size={13} className="favorite-icon" fill="currentColor" aria-label="favorite"/>}
  </span>;
}

export function Books({ data, openBook, read, addFolder, rescan, scanning, bulk, query, setQuery }:
  { data: Snapshot; openBook: (book: Book)=>void; read:(book:Book)=>void; addFolder:()=>void;
    rescan:()=>void; scanning:boolean; bulk:(ids:string[], action:string)=>Promise<void>;
    query:string; setQuery:(q:string)=>void }) {
  const [filters, setFilters] = useState(defaults);
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('deft-book-sort') as Sort) || 'recent');
  const [reverse, setReverse] = useState(() => localStorage.getItem('deft-book-sort-reverse') === 'true');
  const [view, setView] = useState(() => localStorage.getItem('deft-book-view') || 'grid');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [page, setPage] = useState(1);
  const [bulkBusy, setBulkBusy] = useState(false);
  const filterCount = Object.values(filters).filter(Boolean).length;
  const total = data.books.filter(book => !book.ignored && !book.missing).length;
  const recent = useMemo(() => data.books.filter(book => !book.ignored && !book.missing && !book.protected &&
    book.lastOpenedAt && book.state !== 'finished' && book.state !== 'abandoned')
    .reduce<Book | undefined>((previous, book) => (book.lastOpenedAt ?? 0) > (previous?.lastOpenedAt ?? 0) ? book : previous, undefined), [data.books]);
  const books = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const members = filters.category ? new Set(data.categories.find(category => category.id === filters.category)?.members.map(member => member.bookId)) : undefined;
    const matching = data.books.filter(book => !book.ignored && (!book.missing || filters.missing)
      && (!filters.state || book.state === filters.state) && (!filters.format || book.format === filters.format)
      && (!filters.favorite || book.favorite) && (!filters.hideProtected || !book.protected)
      && (!filters.matched || Boolean(book.edition)) && (!filters.rating || (book.rating ?? 0) >= Number(filters.rating))
      && (!members || members.has(book.id))
      && (!search || [book.title, ...book.authors, book.series ?? ''].some(value => value.toLocaleLowerCase().includes(search))));
    matching.sort((a, b) => {
      const title = () => collator.compare(a.title, b.title);
      switch (sort) {
        case 'title': return title();
        case 'author': return collator.compare(a.authors[0] ?? '', b.authors[0] ?? '') || title();
        case 'added': return b.addedAt - a.addedAt || title();
        case 'rating': return (b.rating ?? 0) - (a.rating ?? 0) || title();
        case 'progress': return b.progress - a.progress || title();
        default: return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || title();
      }
    });
    return reverse ? matching.reverse() : matching;
  }, [data.books, data.categories, filters, query, sort, reverse]);
  useEffect(() => setPage(1), [filters, query, sort, reverse, view]);
  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const resetSelection = () => { setSelected(new Set()); setSelecting(false); };
  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters(previous => ({...previous,[key]:value}));
  const visible = books.slice(0, page * pageSize);
  const isEmpty = !data.books.some(book => !book.ignored);
  return <section className="screen books-screen">
    <header className="screen-head">
      <div><div className="screen-kicker">library</div><h1>books <span className="heading-count">{total.toLocaleString()}</span></h1></div>
      <div className="row head-actions">
        <button className="button" onClick={rescan} disabled={scanning || !data.folders.length}><RefreshCw size={16} className={scanning ? 'spin' : ''}/>{scanning ? 'scanning' : 'rescan'}</button>
        <button className="button primary" onClick={addFolder} disabled={scanning}><FolderPlus size={16}/>add a folder</button>
      </div>
    </header>
    {recent && !query && !filterCount && !selecting && <section className="continue-card panel" aria-label="continue reading">
      <Cover book={recent}/>
      <div className="continue-info"><span className="screen-kicker accent-text">continue reading</span>
        <button className="title-button" onClick={() => openBook(recent)}>{recent.title}</button>
        <span className="muted">{recent.authors.join(', ')}</span>
        <Progress state={recent.state} progress={recent.progress}/>
      </div>
      <span className="mono muted continue-percent">{percent(recent.progress)}</span>
      <button className="button primary" onClick={() => read(recent)}><BookOpen size={16}/>continue<ArrowRight size={15}/></button>
    </section>}
    <div className="library-toolbar">
      <label className="search-input"><Search size={16}/><input type="search" id="books-search" aria-label="search books"
        placeholder="search titles, authors, series" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="row toolbar-actions">
        <button className={`button ${filterCount ? 'is-active' : ''}`} onClick={() => setFilterOpen(true)}><SlidersHorizontal size={15}/>filter{filterCount ? <span className="tiny-count">{filterCount}</span> : null}</button>
        <div className="sort-control"><label className="sort-select"><ArrowDownWideNarrow size={16}/><select aria-label="sort books" value={sort} onChange={event => {
          const value = event.target.value as Sort; setSort(value); localStorage.setItem('deft-book-sort', value);
        }}>{Object.entries(sorts).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <button className="icon-button sort-direction" type="button" aria-label="reverse sort order" aria-pressed={reverse}
            title={reverse ? 'restore default sort order' : 'reverse sort order'} onClick={() => {
              setReverse(!reverse);
              localStorage.setItem('deft-book-sort-reverse', String(!reverse));
            }}>{reverse ? <ArrowUp size={17}/> : <ArrowDown size={17}/>}</button>
        </div>
        <div className="switcher" aria-label="library layout">
          <button className="icon-button" aria-label="grid view" aria-pressed={view === 'grid'} onClick={() => {setView('grid');localStorage.setItem('deft-book-view','grid');}}><Grid2X2 size={17}/></button>
          <button className="icon-button" aria-label="list view" aria-pressed={view === 'list'} onClick={() => {setView('list');localStorage.setItem('deft-book-view','list');}}><List size={18}/></button>
        </div>
      </div>
    </div>
    {(books.length > 0 || selecting) && <div className="collection-heading">
      <span className="mono muted">{selecting ? `${selected.size} selected` : `${books.length.toLocaleString()} ${books.length === 1 ? 'book' : 'books'}`}</span>
      <div className="row">
        {selecting && <>
          <button className="button quiet" onClick={() => setSelected(new Set(books.map(book => book.id)))}>select all results</button>
          <select aria-label="bulk action" value="" disabled={!selected.size || bulkBusy} onChange={async event => {
            const action = event.target.value;
            if (!action) return;
            setBulkBusy(true);
            try { await bulk([...selected], action); }
            finally { setBulkBusy(false); }
          }}>
            <option value="">actions</option><option value="category">add to a category</option>
            <option value="state">set reading state</option><option value="match">match editions</option><option value="ignore">ignore</option>
          </select>
        </>}
        <button className="button quiet" onClick={() => selecting ? resetSelection() : setSelecting(true)}>{selecting ? 'done' : 'select books'}</button>
      </div>
    </div>}
    {books.length ? <>
      <div className={view === 'list' ? 'book-list' : 'book-grid'}>
        {visible.map(book => <button type="button" className={`book-tile ${selected.has(book.id) ? 'selected' : ''}`} key={book.id}
          onClick={event => {
            if (selecting || event.ctrlKey || event.metaKey) {setSelecting(true);toggle(book.id);} else openBook(book);
          }} onContextMenu={event => {event.preventDefault();setSelecting(true);toggle(book.id);}}
          aria-pressed={selecting ? selected.has(book.id) : undefined} aria-label={`${book.title}${book.authors.length ? ' by ' + book.authors.join(', ') : ''}`}>
          <div className="tile-cover"><Cover book={book}/>
            {selecting && <span className="tile-check">{selected.has(book.id) && <Check size={15}/>}</span>}
          </div>
          <div className="tile-info"><Progress progress={book.progress} state={book.state}/><strong>{book.title}</strong>
            <span className="tile-author">{book.authors.join(', ') || 'unknown author'}</span><BookBadges book={book}/></div>
          {view === 'list' && <span className="list-meta"><StatePill state={book.state}/><span className="mono muted">{book.format.toUpperCase()} · {percent(book.progress)}</span></span>}
        </button>)}
      </div>
      {visible.length < books.length && <div className="load-more"><button className="button" onClick={() => setPage(page + 1)}>show more books</button></div>}
    </> : <Empty illustration={isEmpty && !query && !filterCount}
      title={query || filterCount ? 'no matching books.' : data.folders.length ? 'nothing here.' : 'no books yet.'}
      action={query || filterCount ? <button className="button" onClick={() => {setQuery('');setFilters(defaults);}}>clear filters</button> :
        data.folders.length ? <button className="button" onClick={rescan} disabled={scanning}><RefreshCw size={15}/>rescan library</button> :
        <button className="button primary" onClick={addFolder} disabled={scanning}><FolderPlus size={17}/>add a folder</button>}>
      {query || filterCount ? 'Try another search or change the active filters.' : data.folders.length ?
        'No supported books in these folders. Check the file types in settings.' : 'Point Deft at a folder and it will find them.'}
    </Empty>}
    {filterOpen && <Modal title="filter books" close={() => setFilterOpen(false)}>
      <div className="filter-fields">
        <label className="field">reading state<select value={filters.state} onChange={e=>updateFilter('state',e.target.value as Filters['state'])}><option value="">any state</option>{Object.entries(stateName).map(([state, label])=><option value={state} key={state}>{label}</option>)}</select></label>
        <label className="field">file format<select value={filters.format} onChange={e=>updateFilter('format',e.target.value)}><option value="">all formats</option>{formats.map(format=><option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label>
        <label className="field">category<select value={filters.category} onChange={e=>updateFilter('category',e.target.value)}><option value="">all categories</option>{data.categories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="field">minimum rating<select value={filters.rating} onChange={e=>updateFilter('rating',e.target.value)}><option value="">any rating</option>{Array.from({length:10},(_,i)=>(i+1)/2).map(rating=><option key={rating} value={rating}>{rating} stars</option>)}</select></label>
      </div>
      <div className="stack filter-toggles">
        {([['favorite','favorites only'],['missing','show missing files'],['hideProtected','hide protected books'],['matched','matched editions only']] as const).map(([key,label]) =>
          <label key={key}><input type="checkbox" checked={filters[key]} onChange={e=>updateFilter(key,e.target.checked)}/>{label}</label>)}
      </div>
      <div className="dialog-actions"><button className="button quiet" onClick={()=>setFilters(defaults)}>reset</button><button className="button primary" onClick={()=>setFilterOpen(false)}>show books</button></div>
    </Modal>}
  </section>;
}
