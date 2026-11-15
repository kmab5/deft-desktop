import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpRight, BarChart3, BookOpen, Bookmark, Check, FolderPlus, HardDrive, LibraryBig, RefreshCw, Search, Settings2, Users, X } from 'lucide-react';
import { rpc, describeError } from './api';
import { applyLibraryChanges, type SnapshotReply } from './libraryRefresh';
import { Books } from './Books';
import { BookDetail, AddCategoryDialog, MatchDialog, StateDialog, gatherMatches, type MatchEntry } from './BookDetail';
import { Authors, Categories, Notes } from './CatalogViews';
import { Reader } from './Reader';
import { Settings } from './Settings';
import { Stats } from './Stats';
import { summarizeBook } from './statistics';
import { type Book, type Locator, type ReadingMode, type ScanReport, type Settings as AppSettings, type Snapshot } from './types';
import { Cover, Mark, Modal } from './ui';

const nav = [
  {id:'books', label:'books', icon:LibraryBig},
  {id:'categories', label:'categories', icon:BookOpen},
  {id:'authors', label:'authors', icon:Users},
  {id:'notes', label:'notes', icon:Bookmark},
  {id:'stats', label:'stats', icon:BarChart3},
] as const;
type Section = typeof nav[number]['id'] | 'settings';
type Route = { section:Section; id?:string; bookId?:string; settingsSection?:string };
type ReaderState = { book:Book; mode:ReadingMode; jump?:Locator };
type Dialog = { type:'read'; book:Book; jump?:Locator }
  | { type:'protected'|'missing'; book:Book } | { type:'match'; entries:MatchEntry[] }
  | { type:'category'|'state'|'ignore'; books:Book[] } | {type:'scan'; report:ScanReport};

const initial: Snapshot = { books:[],authors:[],categories:[],types:[],annotations:[],readThroughs:[],sessions:[],folders:[],settings:{} };

export function App() {
  const [data, setData] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const [fatal, setFatal] = useState('');
  const [route, setRoute] = useState<Route>({section:'books'});
  const [query,setQuery] = useState('');
  const [reader,setReader] = useState<ReaderState>();
  const [dialog,setDialog] = useState<Dialog>();
  const [scanning,setScanning] = useState(false);
  const [lastReport,setLastReport] = useState<ScanReport>();
  const [toast,setToast] = useState('');
  const [finished,setFinished] = useState<Book>();
  const [pendingSettings, setPendingSettings] = useState<{ id: number; patch: Partial<AppSettings> }[]>([]);
  const settingsWrite = useRef<Promise<void>>(Promise.resolve());
  const settingsSequence = useRef(0);
  const toastElement = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<HTMLElement>(null);
  const libraryRevision = useRef<number | undefined>(undefined);
  const refreshQueue = useRef<Promise<void>>(Promise.resolve());
  const dataRef = useRef(data);
  const focusSearch = useRef(false);

  const notice = useCallback((message:string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(()=>setToast(''),4800);
  },[]);
  const refresh = useCallback(() => {
    const request = refreshQueue.current.then(async () => {
      const reply = await rpc<SnapshotReply>('snapshot', { since: libraryRevision.current });
      const next = applyLibraryChanges(dataRef.current, reply);
      libraryRevision.current = reply.revision;
      dataRef.current = next;
      setData(next);
      setLoaded(true);
      setFatal('');
    });
    refreshQueue.current = request.catch(() => {});
    return request;
  }, []);
  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const id = ++settingsSequence.current;
    setPendingSettings(previous => [...previous, { id, patch }]);
    const write = settingsWrite.current.then(async () => {
      await rpc('settingsPatch', { patch });
      await refresh();
    });
    settingsWrite.current = write.catch(() => {});
    try {
      await write;
    } finally {
      setPendingSettings(previous => previous.filter(entry => entry.id !== id));
    }
  }, [refresh]);

  useEffect(() => {
    const element = toastElement.current;
    if (toast && element?.showPopover && !element.matches(':popover-open')) element.showPopover();
  }, [toast]);

  useEffect(()=>{
    void refresh().catch(error=>{setLoaded(true);setFatal(describeError(error));});
    const unlistenScan = listen<ScanReport>('deft:scan',event=>{
      setLastReport(event.payload);
      void refresh().catch(error=>notice(describeError(error)));
    }).catch(()=>()=>{});
    const unlistenError = listen<string>('deft:background-error',event=>notice(event.payload)).catch(()=>()=>{});
    return () => {
      void unlistenScan.then(stop=>stop()).catch(()=>{});
      void unlistenError.then(stop=>stop()).catch(()=>{});
    };
  },[notice,refresh]);
  useEffect(()=>{
    const theme = Object.assign({}, data.settings, ...pendingSettings.map(entry => entry.patch)).appTheme;
    document.documentElement.dataset.theme = theme === 'dark' || theme === 'light' ? theme : 'system';
  },[data.settings, pendingSettings]);
  useEffect(()=>{
    if (!reader) frame.current?.scrollTo({top:0});
    if (route.section === 'books' && !route.bookId && focusSearch.current && !reader) {
      focusSearch.current = false;
      requestAnimationFrame(()=>document.getElementById('books-search')?.focus());
    }
  },[route,reader]);

  const go = useCallback((section:Section,id?:string,settingsSection?:string)=>setRoute({section,id,settingsSection}),[]);
  const openBook = (book:Book)=>setRoute(previous=>({...previous,bookId:book.id}));
  const back = ()=>setRoute(previous=>({...previous,bookId:undefined}));
  const closeDialog = ()=>setDialog(undefined);
  const showSearch = useCallback(()=>{
    if (route.section === 'books' && !route.bookId) document.getElementById('books-search')?.focus();
    else {focusSearch.current = true;go('books');}
  },[route,go]);
  useEffect(()=>{
    if (reader) return;
    const handler = (event:KeyboardEvent)=>{
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'k')) {
        event.preventDefault(); showSearch();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault(); go('settings');
      }
    };
    window.addEventListener('keydown',handler);
    return ()=>window.removeEventListener('keydown',handler);
  },[reader,go,showSearch]);

  const act = useCallback(async (op:string,args:Record<string,unknown>={})=>{
    try {
      const reply = await rpc<{path?:string}|null>(op,args);
      if (op === 'exportToFile' && reply?.path) notice('Export saved.');
      await refresh();
    } catch (error) {
      notice(describeError(error));
      throw error;
    }
  },[notice,refresh]);
  const scan = async (op:'folderAdd'|'scan')=>{
    if (scanning) return;
    setScanning(true);
    try {
      const report = await rpc<ScanReport | null>(op,op === 'scan' ? {force:true}: {});
      if (report) {
        setLastReport(report);
        notice(`added ${report.added} · missing ${report.missing} · ${report.errors.length} ${report.errors.length === 1 ? 'error' : 'errors'}`);
        await refresh();
      }
    } catch (error) {notice(describeError(error));}
    finally {setScanning(false);}
  };
  const read = (book:Book,jump?:Locator)=>{
    if (book.missing) {setDialog({type:'missing',book});return;}
    if (book.protected) {setDialog({type:'protected',book});return;}
    if (book.state === 'abandoned' || book.state === 'finished') {setDialog({type:'read',book,jump});return;}
    setReader({book,mode:'normal',jump});
  };
  const launch = (entry:{book:Book;jump?:Locator},mode:ReadingMode)=>{
    closeDialog();
    setReader({...entry,mode});
  };
  const closeReader = async ()=>{
    const previous = reader;
    setReader(undefined);
    try {
      await refresh();
      const book = dataRef.current.books.find(book=>book.id === previous?.book.id);
      if (book?.state === 'finished' && previous?.book.state !== 'finished' && dataRef.current.settings.celebrations !== false) {
        setFinished(book);
        setTimeout(()=>setFinished(undefined),2800);
      }
    } catch (error){notice(describeError(error));}
  };
  const match = async (ids:string[])=>{
    const matching = ids.map(id=>dataRef.current.books.find(book=>book.id === id)).filter((book):book is Book=>!!book);
    try {
      const entries = await gatherMatches(matching,notice);
      await refresh();
      if (entries.length) setDialog({type:'match',entries});
      else notice('Exact ISBN matches saved.');
    } catch (error) {notice(describeError(error));}
  };
  const bulk = async (ids:string[],type:string)=>{
    if (type === 'match') {await match(ids);return;}
    const books = data.books.filter(book=>ids.includes(book.id));
    if (books.length && (type === 'category' || type === 'state' || type === 'ignore')) setDialog({type,books});
  };

  const liveBooks = data.books.filter(book=>!book.ignored && !book.missing).length;
  const book = route.bookId ? data.books.find(entry=>entry.id === route.bookId) : undefined;
  const viewProps = {data,act,notice,openBook,read};
  const settings = Object.assign({}, data.settings, ...pendingSettings.map(entry => entry.patch));
  const estimate = reader ? summarizeBook(data, reader.book.id).estimateSeconds : undefined;
  const accent = typeof data.settings.accent === 'string' && /^#[0-9a-f]{6}$/i.test(data.settings.accent)
    ? {'--accent':data.settings.accent,'--accent-text':data.settings.accent} as CSSProperties : undefined;
  return <div className="app-root" style={accent}>
    {reader ? <Reader key={reader.book.id} {...reader} settings={settings} estimateSeconds={estimate}
      annotations={data.annotations.filter(note=>note.bookId === reader.book.id)} close={closeReader}
      updateSettings={saveSettings} refresh={refresh} notice={notice}/> :
      <div className="desktop-shell">
        <aside className="sidebar">
          <button className="sidebar-brand" onClick={()=>go('books')} aria-label="Deft home"><span className="brand-icon"><Mark size={36}/></span><span>deft</span></button>
          <nav aria-label="main navigation">
            {nav.map(({id,label,icon:Icon})=><button key={id} className={`sidebar-link ${route.section === id ? 'current' : ''}`}
              aria-current={route.section === id ? 'page' : undefined} onClick={()=>go(id)}><Icon size={18}/><span>{label}</span>
              {id === 'books' && liveBooks > 0 && <small>{liveBooks.toLocaleString()}</small>}</button>)}
          </nav>
          <div className="sidebar-bottom">
            <button className={`sidebar-link ${route.section === 'settings' ? 'current' : ''}`} aria-current={route.section === 'settings' ? 'page' : undefined} onClick={()=>go('settings')}><Settings2 size={18}/><span>settings</span></button>
            <button className="sidebar-storage" onClick={()=>go('settings',undefined,'library')} title="library folders"><HardDrive size={15}/><span>{data.folders.length} {data.folders.length === 1 ? 'folder' : 'folders'}</span><ArrowUpRight size={13}/></button>
          </div>
        </aside>
        <div className="desktop-main">
          <header className="topbar">
            <div className="topbar-path"><span>deft</span><span>/</span><strong>{route.section}</strong>{book && <><span>/</span><strong className="topbar-book">{book.title}</strong></>}</div>
            <div className="row topbar-actions">
              {lastReport && lastReport.errors.length > 0 && <button className="button quiet scan-errors" onClick={()=>setDialog({type:'scan',report:lastReport})}>{lastReport.errors.length} scan {lastReport.errors.length === 1 ? 'error' : 'errors'}</button>}
              <button className="icon-button" title="search library (Ctrl+F)" aria-label="search library" onClick={showSearch}><Search size={18}/></button>
              <button className="icon-button" title="add a folder" aria-label="add a folder to the library" disabled={scanning} onClick={()=>{void scan('folderAdd');}}><FolderPlus size={19}/></button>
            </div>
          </header>
          <main className="workspace" ref={frame}>
            {!loaded ? <div className="app-loading"><Mark size={54}/><span>opening library</span></div> :
              fatal ? <div className="startup-error panel"><h1>library unavailable</h1><p>{fatal}</p><button className="button" onClick={()=>void refresh().catch(error=>setFatal(describeError(error)))}><RefreshCw size={16}/>try again</button></div> :
              book ? <BookDetail key={book.id} {...viewProps} book={book} back={back} match={match}
                openAuthor={id=>go('authors',id)} openCategory={id=>go('categories',id)} openNotes={id=>go('notes',id)}/> :
              route.section === 'books' ? <Books {...viewProps} query={query} setQuery={setQuery}
                addFolder={()=>void scan('folderAdd')} rescan={()=>void scan('scan')} scanning={scanning} bulk={bulk}/> :
              route.section === 'categories' ? <Categories {...viewProps} categoryId={route.id} openCategory={id=>go('categories',id)}/> :
              route.section === 'authors' ? <Authors {...viewProps} authorId={route.id} openAuthor={id=>go('authors',id)}/> :
              route.section === 'notes' ? <Notes {...viewProps} bookId={route.id} setBookId={id=>go('notes',id)}/> :
              route.section === 'stats' ? <Stats data={data} refresh={refresh} notice={notice} openSettings={()=>go('settings',undefined,'goals')}/> :
              <Settings key={route.settingsSection ?? 'settings'} data={{ ...data, settings }} refresh={refresh} notice={notice} saveSettings={saveSettings} initialSection={route.settingsSection as never}/>}
          </main>
        </div>
      </div>}
    {!!toast && <div className="toast" role="status" ref={toastElement} popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined}><span>{toast}</span><button className="icon-button" aria-label="dismiss notification" onClick={()=>setToast('')}><X size={16}/></button></div>}
    {dialog?.type === 'protected' && <Modal title="this file is protected." close={closeDialog}><p>This file is locked with DRM. You can still rate it, categorize it, and match an edition.</p><div className="dialog-actions"><button className="button primary" onClick={closeDialog}>ok</button></div></Modal>}
    {dialog?.type === 'missing' && <Modal title="file missing." close={closeDialog}><p>Deft can't find this file anymore. Its history is safe.</p><div className="dialog-actions"><button className="button primary" onClick={closeDialog}>ok</button></div></Modal>}
    {dialog?.type === 'read' && <Modal title={dialog.book.state === 'finished' ? "you've finished this." : 'you set this one down.'} close={closeDialog}>
      <p>{dialog.book.state === 'finished' ? 'Re-reading starts a new read-through. Browsing keeps its own sessions.' : 'Pick up where you left off, or start over?'}</p>
      <div className="dialog-actions">{dialog.book.state === 'finished' ? <>
        <button className="button" onClick={()=>launch(dialog,'browse')}>just browsing</button>
        <button className="button primary" onClick={()=>launch({book:dialog.book},'reread')}>re-read</button></> : <>
        <button className="button" onClick={()=>launch({book:dialog.book},'restart')}>start over</button>
        <button className="button primary" onClick={()=>launch(dialog,'resume')}>resume</button></>}</div>
    </Modal>}
    {dialog?.type === 'category' && <AddCategoryDialog data={data} books={dialog.books} close={closeDialog} act={act}/>}
    {dialog?.type === 'state' && <StateDialog books={dialog.books} close={closeDialog} act={act}/>}
    {dialog?.type === 'match' && <MatchDialog entries={dialog.entries} close={closeDialog} act={act} notice={notice}/>}
    {dialog?.type === 'ignore' && <Modal title={`ignore ${dialog.books.length} ${dialog.books.length === 1 ? 'book' : 'books'}?`} close={closeDialog}>
      <p>Ignored books disappear from the library and stats. You can bring them back in settings.</p><div className="dialog-actions"><button className="button" onClick={closeDialog}>cancel</button>
        <button className="button danger" onClick={()=>void act('bookPatch',{bookIds:dialog.books.map(book=>book.id),ignored:true}).then(closeDialog).catch(()=>{})}>ignore</button></div>
    </Modal>}
    {dialog?.type === 'scan' && <Modal title="scan results" close={closeDialog} wide>
      <p className="mono muted">added {dialog.report.added} · missing {dialog.report.missing} · {dialog.report.scanned} files scanned</p>
      <ul className="scan-list">{dialog.report.errors.map((error,index)=><li key={index}>{error}</li>)}</ul>
      <div className="dialog-actions"><button className="button primary" onClick={closeDialog}>done</button></div>
    </Modal>}
    {finished && <div className="celebration" role="status" onClick={()=>setFinished(undefined)}>
      <Cover book={finished}/><Check size={32}/><strong>finished.</strong><span>{finished.title}</span>
      <button className="button" onClick={()=>setFinished(undefined)}>done</button>
    </div>}
  </div>;
}
