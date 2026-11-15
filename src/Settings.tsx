import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BookOpen, Database, Download, FolderOpen, HardDrive, Info, Paintbrush,
  Plus, RefreshCw, Search, Timer, Trash2, Trophy, Upload,
} from 'lucide-react';
import { rpc } from './api';
import { version } from '../package.json';
import { formats } from './types';
import type { ScanReport, Settings as Preferences, Snapshot } from './types';
import './insights.css';

export type ReaderSection = 'text' | 'theme' | 'page';
export type ReaderTheme = { id: string; name: string; background: string; text: string; accent: string };
export type ImportedFont = { id: string; name: string; data: string };
export type PreferencePatch = Record<string, unknown>;

export const READER_THEMES: ReaderTheme[] = [
  { id: 'light', name: 'light', background: '#FBF9F4', text: '#1B1B1F', accent: '#7D34B2' },
  { id: 'sepia', name: 'sepia', background: '#F1E7D0', text: '#4A3B28', accent: '#7D34B2' },
  { id: 'dark', name: 'dark', background: '#17171B', text: '#D8D5CC', accent: '#C373FF' },
  { id: 'black', name: 'black', background: '#000000', text: '#B8B6AE', accent: '#C373FF' },
];

export const READER_FONTS = [
  'original', 'Literata', 'Source Serif 4', 'PT Serif', 'EB Garamond', 'Crimson Pro',
  'Bitter', 'Lato', 'Open Sans', 'Inter', 'Atkinson Hyperlegible', 'OpenDyslexic',
] as const;

const SECTIONS = [
  { id: 'library', label: 'library', Icon: FolderOpen },
  { id: 'reader', label: 'reader', Icon: BookOpen },
  { id: 'tracking', label: 'tracking', Icon: Timer },
  { id: 'goals', label: 'goals', Icon: Trophy },
  { id: 'appearance', label: 'appearance', Icon: Paintbrush },
  { id: 'matching', label: 'matching', Icon: Search },
  { id: 'backup', label: 'backup & export', Icon: Database },
  { id: 'storage', label: 'storage', Icon: HardDrive },
  { id: 'about', label: 'about', Icon: Info },
] as const;

type Section = typeof SECTIONS[number]['id'];
type SettingsProps = {
  data: Snapshot;
  refresh: () => void | Promise<void>;
  notice: (message: string) => void;
  initialSection?: Section;
  saveSettings: (patch: PreferencePatch) => Promise<void>;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function Switch({ label, help, value, change, disabled }: {
  label: string;
  help?: string;
  value: boolean;
  change: (value: boolean) => void | Promise<void>;
  disabled?: boolean;
}) {
  return <label className="pref-switch">
    <span><strong>{label}</strong>{help && <span className="muted">{help}</span>}</span>
    <input type="checkbox" role="switch" checked={value} disabled={disabled} onChange={e => void change(e.target.checked)} />
  </label>;
}

type Option = string | { value: string; label: string };
function Choice({ label, value, options, change, disabled }: {
  label: string;
  value: string;
  options: readonly Option[];
  change: (value: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  return <label className="pref-field"><span>{label}</span>
    <select aria-label={label} value={value} disabled={disabled} onChange={e => void change(e.target.value)}>
      {options.map(option => typeof option === 'string'
        ? <option key={option} value={option}>{option}</option>
        : <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function Numeric({ label, value, change, min, max, unit, zero, step = 1 }: {
  label: string;
  value: number;
  change: (value: number) => void | Promise<void>;
  min: number;
  max: number;
  unit?: string;
  zero?: string;
  step?: number;
}) {
  const [raw, setRaw] = useState(value ? String(value) : zero ? '' : String(value));
  useEffect(() => setRaw(value ? String(value) : zero ? '' : String(value)), [value, zero]);
  function commit() {
    const next = raw.trim() === '' && zero ? 0 : Number(raw);
    if (!Number.isFinite(next)) {
      setRaw(value ? String(value) : '');
      return;
    }
    const snapped = Number((Math.round(next / step) * step).toFixed(4));
    const safe = zero && next === 0 ? 0 : Math.max(min, Math.min(max, snapped));
    setRaw(safe || !zero ? String(safe) : '');
    if (safe !== value) void change(safe);
  }
  return <label className="pref-field"><span>{label}</span><span className="pref-numeric">
    <input type="number" aria-label={label} className="mono" min={zero ? 0 : min} max={max} step={step} value={raw} placeholder={zero}
      onChange={e => setRaw(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    {unit && <span className="muted">{unit}</span>}
  </span></label>;
}

function Stepper({ label, value, min, max, step, change, format }: {
  label: string; value: number; min: number; max: number; step: number;
  change: (value: number) => void | Promise<void>; format?: (value: number) => string;
}) {
  return <div className="pref-field"><span>{label}</span>
    <div className="pref-stepper">
      <button type="button" className="button" aria-label={`decrease ${label}`} disabled={value <= min}
        onClick={() => void change(Math.max(min, Number((value - step).toFixed(2))))}>−</button>
      <output className="mono" aria-live="polite">{format?.(value) ?? value}</output>
      <button type="button" className="button" aria-label={`increase ${label}`} disabled={value >= max}
        onClick={() => void change(Math.min(max, Number((value + step).toFixed(2))))}>+</button>
    </div>
  </div>;
}

function ThemeSwatches({ label, themes, current, choose }: {
  label: string; themes: ReaderTheme[]; current: string; choose: (id: string) => void | Promise<void>;
}) {
  return <div className="pref-themes" aria-label={label}>{themes.map(theme =>
    <button type="button" key={theme.id} className="pref-swatch" aria-pressed={current === theme.id}
      style={{ background: theme.background, color: theme.text, borderColor: current === theme.id ? theme.accent : undefined }}
      onClick={() => void choose(theme.id)}>
      <strong>Aa</strong><span>{theme.name}</span>
    </button>)}</div>;
}

export function ReaderPreferences({ settings, patch, section, compact, bookFormat }: {
  settings: Preferences;
  patch: (patch: PreferencePatch) => void | Promise<void>;
  section?: ReaderSection;
  compact?: boolean;
  bookFormat?: string;
}) {
  const [tab, setTab] = useState<ReaderSection>('text');
  const active = section ?? tab;
  const change = (key: string) => (value: unknown) => patch({ [key]: value });
  const customThemes = (settings.customThemes ?? []) as ReaderTheme[];
  const fixed = ['pdf', 'djvu', 'cbz'].includes(bookFormat ?? '');
  const fonts = (settings.importedFonts ?? []) as ImportedFont[];
  const themes = [...READER_THEMES, ...customThemes];
  const swatchOptions = themes.map(theme => ({ value: theme.id, label: theme.name }));
  const marginOptions = [{ value: 's', label: 'small' }, { value: 'm', label: 'medium' }, { value: 'l', label: 'large' }];
  const lengthOptions = [{ value: 'width', label: 'fit width' }, { value: 'page', label: 'fit page' }, { value: 'height', label: 'fit height' }];
  return <div className={`deft-reader-preferences${compact ? ' pref-compact' : ''}`}>
    {!section && <div className="pref-tabs" aria-label="Reader preferences">
      {(['text', 'theme', 'page'] as const).map(item =>
        <button type="button" key={item} className="button quiet" aria-pressed={active === item} onClick={() => setTab(item)}>{item}</button>)}
    </div>}
    {active === 'text' && <div className="pref-rows">
      {fixed && compact && <p className="muted pref-help">Text options apply to reflowable books.</p>}
      <Choice label="font" value={settings.readerFont ?? 'Literata'} options={[...READER_FONTS, ...fonts.map(font => font.name)]} change={change('readerFont')} />
      <Stepper label="font size" value={settings.readerFontSize ?? 19} min={12} max={48} step={1} change={change('readerFontSize')} format={n => `${n} px`} />
      <Stepper label="line spacing" value={settings.readerLineSpacing ?? 1.65} min={1} max={2.5} step={0.05} change={change('readerLineSpacing')} />
      <Choice label="margins" value={settings.readerMargins ?? 'm'} options={marginOptions} change={change('readerMargins')} />
      <Choice label="alignment" value={settings.readerAlignment ?? 'start'} options={[{ value: 'start', label: 'start' }, { value: 'justify', label: 'justified' }]} change={change('readerAlignment')} />
      <Switch label="hyphenation" value={settings.readerHyphenation !== false} change={change('readerHyphenation')} />
    </div>}
    {active === 'theme' && <div className="pref-rows">
      <ThemeSwatches label="Reader theme" themes={themes} current={settings.readerTheme ?? 'sepia'} choose={change('readerTheme')} />
      <Switch label="follow system day / night" value={settings.readerFollowSystem === true} change={change('readerFollowSystem')} />
      {settings.readerFollowSystem && <>
        <Choice label="day theme" value={settings.readerDayTheme ?? 'light'} options={swatchOptions} change={change('readerDayTheme')} />
        <Choice label="night theme" value={settings.readerNightTheme ?? 'dark'} options={swatchOptions} change={change('readerNightTheme')} />
      </>}
      <Switch label="use system brightness" value={settings.readerUseSystemBrightness !== false} change={change('readerUseSystemBrightness')} />
      <label className="pref-field"><span>reader brightness</span><span className="pref-range">
        <input type="range" min={25} max={100} value={settings.readerBrightness ?? 100} disabled={settings.readerUseSystemBrightness !== false}
          onChange={e => void patch({ readerBrightness: Number(e.target.value) })} />
        <output className="mono">{settings.readerBrightness ?? 100}%</output>
      </span></label>
    </div>}
    {active === 'page' && <div className="pref-rows">
      <Choice label="page layout" value={settings.readerLayout ?? 'paged'} options={['paged', 'scroll']} change={change('readerLayout')} />
      <Choice label="page-turn animation" value={settings.readerAnimation ?? 'none'} options={['none', 'slide']} change={change('readerAnimation')} />
      <Choice label="progress display" value={settings.readerProgressDisplay ?? 'percentage'}
        options={[{ value: 'percentage', label: 'percentage' }, { value: 'page', label: 'page number' }]}
        change={change('readerProgressDisplay')} />
      <Switch label="status line" value={settings.readerStatusLine === true} change={change('readerStatusLine')} />
      <Switch label="volume keys turn pages" help={!compact ? 'Applies on keyboards that deliver media keys to the app.' : undefined}
        value={settings.readerVolumeKeys === true} change={change('readerVolumeKeys')} />
      <Switch label="keep screen on while reading" value={settings.readerKeepAwake !== false} change={change('readerKeepAwake')} />
      {(!compact || fixed) && <>
        <Choice label="fixed-layout fit" value={settings.readerFixedFit ?? 'page'} options={lengthOptions} change={change('readerFixedFit')} />
        <Switch label="invert fixed-layout books" value={settings.readerFixedInvert === true} change={change('readerFixedInvert')} />
        {(!compact || bookFormat === 'cbz') && <Switch label="right-to-left comic pages" value={settings.readerFixedRtl === true} change={change('readerFixedRtl')} />}
        {(!compact || bookFormat !== 'cbz') && <Switch label="crop PDF and DjVu margins" value={settings.readerFixedCrop === true} change={change('readerFixedCrop')} />}
      </>}
    </div>}
  </div>;
}

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="panel pref-group"><header><h2>{title}</h2>{action}</header>{children}</section>;
}

function ThemeEditor({ themes, settings, patch }: {
  themes: ReaderTheme[]; settings: Preferences; patch: (prefs: PreferencePatch) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<ReaderTheme>();
  function edit(theme?: ReaderTheme) {
    setDraft(theme ?? { ...READER_THEMES[0], id: crypto.randomUUID(), name: '' });
  }
  async function remove(theme: ReaderTheme) {
    const update: PreferencePatch = { customThemes: themes.filter(item => item.id !== theme.id) };
    if (settings.readerTheme === theme.id) update.readerTheme = 'sepia';
    if (settings.readerDayTheme === theme.id) update.readerDayTheme = 'light';
    if (settings.readerNightTheme === theme.id) update.readerNightTheme = 'dark';
    await patch(update);
    if (draft?.id === theme.id) setDraft(undefined);
  }
  return <Panel title="custom themes" action={<button className="button quiet" onClick={() => edit()}><Plus size={16} aria-hidden /> add theme</button>}>
    {themes.length === 0 && !draft && <p className="muted">Choose your own paper, text and link colors.</p>}
    {themes.map(theme => <div key={theme.id} className="pref-list-item">
      <span className="pref-theme-dot" style={{ backgroundColor: theme.background, color: theme.text }}>Aa</span>
      <strong>{theme.name}</strong>
      <button className="button quiet" onClick={() => edit(theme)}>edit</button>
      <button className="button quiet" onClick={() => void remove(theme)} aria-label={`remove ${theme.name} theme`}><Trash2 size={15} aria-hidden /></button>
    </div>)}
    {draft && <form className="pref-edit-form" onSubmit={async e => {
      e.preventDefault();
      const name = draft.name.trim();
      if (!name) return;
      const saved = { ...draft, name };
      const existing = themes.some(theme => theme.id === saved.id);
      await patch({ customThemes: existing ? themes.map(theme => theme.id === saved.id ? saved : theme) : [...themes, saved] });
      setDraft(undefined);
    }}>
      <label className="pref-field"><span>name</span><input value={draft.name} maxLength={48} required onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      {(['background', 'text', 'accent'] as const).map(key => <label key={key} className="pref-field"><span>{key}</span>
        <input type="color" value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} />
      </label>)}
      <div className="pref-actions"><button type="submit" className="button primary">save theme</button><button type="button" className="button quiet" onClick={() => setDraft(undefined)}>cancel</button></div>
    </form>}
  </Panel>;
}

function TokenEntry({ value, save }: { value: string; save: (value: string) => void | Promise<void> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <form className="pref-token" onSubmit={e => { e.preventDefault(); void save(draft.trim()); }}>
    <label className="pref-field"><span>hardcover API token</span>
      <input type="password" value={draft} autoComplete="off" onChange={e => setDraft(e.target.value)} />
    </label>
    <button type="submit" className="button" disabled={draft.trim() === value}>save token</button>
  </form>;
}

type Exports = { matchedOnly: boolean; includeReviews: boolean; includeNotes: boolean };

export function Settings({ data, refresh, notice, saveSettings, initialSection = 'library' }: SettingsProps) {
  const [section, setSection] = useState<Section>(initialSection);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<ScanReport>();
  const [readerTab, setReaderTab] = useState<ReaderSection>('text');
  const [options, setOptions] = useState<Exports>({ matchedOnly: true, includeReviews: false, includeNotes: false });
  const [goalYear, setGoalYear] = useState(new Date().getFullYear());
  const [confirmation, setConfirmation] = useState<{ label: string; detail: string; action: () => void | Promise<void> }>();
  const [restoredFolders, setRestoredFolders] = useState<string[]>([]);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const mutation = useRef(false);
  const patchQueue = useRef<Promise<void>>(Promise.resolve());
  const settings = data.settings as Preferences;
  const enabledFormats = (settings.formats ?? [...formats]) as string[];
  const imported = (settings.importedFonts ?? []) as ImportedFont[];
  const customThemes = (settings.customThemes ?? []) as ReaderTheme[];
  const ignored = data.books.filter(book => book.ignored);
  const goal = settings.goals?.[goalYear] ?? {};
  const title = SECTIONS.find(group => group.id === section)?.label;
  const paperTheme = settings.appTheme === 'light' ||
    ((settings.appTheme == null || settings.appTheme === 'system') &&
      typeof matchMedia !== 'undefined' && !matchMedia('(prefers-color-scheme: dark)').matches);
  const defaultAccent = paperTheme ? '#b24bff' : '#c373ff';
  const unmatched = data.books.filter(book => !book.ignored && !book.edition).length;

  useEffect(() => { setSection(initialSection); }, [initialSection]);
  useEffect(() => {
    const dialog = confirmDialog.current;
    if (confirmation && dialog && !dialog.open) dialog.showModal();
  }, [confirmation]);

  async function run<T>(name: string, action: () => Promise<T>, after?: (result: T) => void) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(name);
    setError('');
    const task = patchQueue.current.then(async () => {
      try {
        const result = await action();
        await refresh();
        after?.(result);
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        mutation.current = false;
        setBusy('');
      }
    });
    patchQueue.current = task;
    await task;
  }

  function patch(prefs: PreferencePatch) {
    setError('');
    const request = saveSettings(prefs).catch(failure => setError(errorMessage(failure)));
    patchQueue.current = request;
    return request;
  }

  const set = (key: string) => (value: unknown) => patch({ [key]: value });
  function setFormats(next: string[]) {
    if (!data.folders.length) return void set('formats')(next);
    void run('scan', async () => {
      await saveSettings({ formats: next });
      return rpc<ScanReport>('scan', { force: true });
    }, setReport);
  }
  function scanFolder(op: string, args?: Record<string, unknown>) {
    return run('scan', () => rpc<ScanReport | null>(op, args), outcome => {
      if (outcome) setReport(outcome);
    });
  }
  const setGoal = (key: string) => (value: number) => patch({ goals: {
    ...(settings.goals ?? {}),
    [goalYear]: { ...goal, [key]: value },
  } });
  const changeExport = (key: keyof Exports) => (value: boolean) => setOptions(current => ({ ...current, [key]: value }));
  const exportFile = (kind: 'csv' | 'profile' | 'backup') => run(kind,
    () => rpc<unknown>('exportToFile', { kind, options }), result => {
      if (result != null) notice(kind === 'backup' ? 'Backup saved.' : 'Export saved.');
    },
  );

  return <section className="insight-page prefs-page">
    <div className="insight-heading"><h1>settings</h1></div>
    <div className="prefs-layout">
      <nav className="pref-nav" aria-label="Settings sections">{SECTIONS.map(({ id, label, Icon }) =>
        <button className="button quiet" type="button" key={id} aria-current={section === id ? 'page' : undefined}
          onClick={() => { setSection(id); setError(''); }}><Icon size={17} aria-hidden /><span>{label}</span></button>)}</nav>
      <div className="pref-content" aria-label={title}>
        {(error || busy) && <div className="pref-feedback" role={error ? 'alert' : 'status'}>
          {error || (busy === 'scan' ? 'Scanning folders…' : 'Working…')}
          {error && <button className="button quiet" onClick={() => setError('')}>dismiss</button>}
        </div>}
        {section === 'library' && <>
          <Panel title="folders" action={<button className="button" disabled={Boolean(busy)} onClick={() => void scanFolder('folderAdd')}><Plus size={16} aria-hidden /> add a folder</button>}>
            {data.folders.length === 0 && <p className="muted">Point Deft at a folder and it will find your books.</p>}
            {data.folders.map(folder => <div className="pref-folder" key={folder.id}>
              <div className="pref-folder-main"><FolderOpen size={19} aria-hidden /><div><strong>{folder.path}</strong>
                {!folder.available && <p className="muted">Folder unavailable</p>}</div></div>
              <div className="pref-actions">
                <button className="button quiet" disabled={Boolean(busy)} onClick={() => void scanFolder('folderExclude', { id: folder.id })}>exclude subfolder</button>
                <button className="button quiet" disabled={Boolean(busy)} onClick={() => setConfirmation({ label: 'remove folder', detail: 'Its books will be marked missing. Their history stays.', action: () => scanFolder('folderRemove', { id: folder.id }) })}>remove</button>
              </div>
              {folder.exclusions?.map(path => <div className="pref-exclusion" key={path}><span className="muted" title={path}>{path}</span>
                <button className="button quiet" disabled={Boolean(busy)} onClick={() => void scanFolder('folderUnexclude', { id: folder.id, path })}>include again</button></div>)}
            </div>)}
          </Panel>
          <Panel title="scan" action={<button className="button" disabled={Boolean(busy) || data.folders.length === 0}
            onClick={() => void run('scan', () => rpc<ScanReport>('scan', { force: true }), setReport)}><RefreshCw size={16} aria-hidden /> rescan</button>}>
            {data.lastScan ? <p className="muted">Last scan {new Date(data.lastScan).toLocaleString()}.</p> : <p className="muted">Deft checks the selected folders on startup.</p>}
            {report && <div className="pref-scan-report" role="status">
              <span className="mono">scanned {report.scanned} · added {report.added} · missing {report.missing} · {report.errors.length} errors</span>
              {report.errors.length > 0 && <details><summary>scan errors</summary><ul>{report.errors.map((failure, i) => <li key={i}>{failure}</li>)}</ul></details>}
            </div>}
            <div className="pref-formats" aria-label="Library file types">{formats.map(format =>
              <label key={format}><input type="checkbox" checked={enabledFormats.includes(format)} disabled={Boolean(busy)} onChange={e => setFormats(
                e.target.checked ? [...enabledFormats, format] : enabledFormats.filter(value => value !== format),
              )} />{format.toUpperCase()}</label>)}</div>
            <Switch label="auto-fill series from file metadata" value={settings.seriesAutoFill !== false} change={set('seriesAutoFill')} />
            <Switch label="prepare recent books in background" help="Prepares up to eight previously opened books at startup." value={settings.prepareInBackground === true} change={set('prepareInBackground')} />
          </Panel>
          <Panel title="ignored books">
            {ignored.length === 0 ? <p className="muted">No ignored books.</p> : ignored.map(book =>
              <div className="pref-list-item" key={book.id}><strong>{book.title}</strong>
                <button className="button quiet" disabled={Boolean(busy)} onClick={() => void run('unignore', () => rpc('bookPatch', { bookId: book.id, ignored: false }))}>bring back</button></div>)}
          </Panel>
        </>}
        {section === 'reader' && <>
          <Panel title="reading preferences">
            <div className="pref-tabs" aria-label="Reader preferences">
              {(['text', 'theme', 'page'] as const).map(item =>
                <button className="button quiet" key={item} aria-pressed={item === readerTab} onClick={() => setReaderTab(item)}>{item}</button>)}
            </div>
            <ReaderPreferences settings={settings} patch={patch} section={readerTab} />
          </Panel>
          {readerTab === 'text' && <Panel title="imported fonts" action={<button className="button" disabled={Boolean(busy)} onClick={() => void run('font', () => rpc('importFont'))}>
            <Plus size={16} aria-hidden /> import a font</button>}>
            {imported.length === 0 && <p className="muted">Add a local TTF or OTF file.</p>}
            {imported.map(font => <div className="pref-list-item" key={font.id}><strong>{font.name}</strong>
              <button className="button quiet" onClick={() => void patch({
                importedFonts: imported.filter(item => item.id !== font.id),
                ...(settings.readerFont === font.name ? { readerFont: 'Literata' } : {}),
              })} aria-label={`remove ${font.name} font`}><Trash2 size={15} aria-hidden /></button>
            </div>)}
          </Panel>}
          {readerTab === 'text' && <Panel title="dictionary">
            <p className="muted">Choose a local dictionary app to define selected text.</p>
            {settings.dictionaryPath && <div className="pref-selected-path mono" title={settings.dictionaryPath}>{settings.dictionaryPath}</div>}
            <div className="pref-actions">
              <button className="button" disabled={Boolean(busy)} onClick={() => void run('dictionary', () => rpc('chooseDictionary'))}>
                <FolderOpen size={16} aria-hidden /> {settings.dictionaryPath ? 'change dictionary app' : 'choose dictionary app'}</button>
              {settings.dictionaryPath && <button className="button quiet" disabled={Boolean(busy)} onClick={() => void run('dictionary', () => rpc('clearDictionary'))}>clear dictionary</button>}
            </div>
          </Panel>}
          {readerTab === 'theme' && <ThemeEditor themes={customThemes} settings={settings} patch={patch} />}
        </>}
        {section === 'tracking' && <Panel title="automatic sessions">
          <p className="muted">The clock runs while the reader is focused and active. Set either idle limit to 0 to turn it off.</p>
          <Numeric label="reflowable idle timeout" value={settings.reflowIdleMinutes ?? 5} change={set('reflowIdleMinutes')} min={1} max={60} zero="off" unit="min" />
          <Numeric label="fixed-layout idle timeout" value={settings.fixedIdleMinutes ?? 10} change={set('fixedIdleMinutes')} min={1} max={60} zero="off" unit="min" />
          <Numeric label="minimum session" value={settings.minSessionSeconds ?? 60} change={set('minSessionSeconds')} min={60} max={600} unit="sec" />
          <Numeric label="streak threshold" value={settings.streakMinutes ?? 1} change={set('streakMinutes')} min={1} max={1_440} unit="min per day" />
          <Switch label="show tracking indicator in the reader" value={settings.trackingIndicator === true} change={set('trackingIndicator')} />
        </Panel>}
        {section === 'goals' && <Panel title="reading goals">
          <Numeric label="calendar year" value={goalYear} change={setGoalYear} min={1900} max={9999} />
          <Numeric label="yearly books" key={`books-${goalYear}`} value={goal.booksTarget ?? 0} change={setGoal('booksTarget')} min={1} max={10_000} zero="off" unit="books" />
          <Numeric label="daily reading time" key={`daily-${goalYear}`} value={goal.dailyMinutesTarget ?? 0} change={setGoal('dailyMinutesTarget')} min={1} max={1_440} zero="off" unit="min" />
        </Panel>}
        {section === 'appearance' && <Panel title="app appearance">
          <Choice label="color theme" value={settings.appTheme ?? 'system'} options={['system', 'light', 'dark']} change={set('appTheme')} />
          <div className="pref-field"><label htmlFor="deft-accent">accent color</label><div className="pref-actions">
            <input id="deft-accent" type="color" value={settings.accent || defaultAccent}
              onChange={e => void set('accent')(e.target.value)} />
            <button className="button quiet" disabled={!settings.accent} onClick={() => void set('accent')('')}>reset</button>
          </div></div>
          <Switch label="celebrations" help="Celebrate finished books, goals and milestones." value={settings.celebrations !== false} change={set('celebrations')} />
        </Panel>}
        {section === 'matching' && <Panel title="edition providers">
          <p className="muted">Deft searches these catalogs when you ask to match an edition.</p>
          <Switch label="Open Library" value={settings.matchingOpenLibrary !== false} change={set('matchingOpenLibrary')} />
          <Switch label="Google Books" value={settings.matchingGoogleBooks !== false} change={set('matchingGoogleBooks')} />
          <Switch label="Hardcover" value={settings.matchingHardcover === true} change={set('matchingHardcover')} />
          <TokenEntry value={settings.hardcoverToken ?? ''} save={set('hardcoverToken')} />
        </Panel>}
        {section === 'backup' && <>
          <Panel title="export reading history">
            <Switch label="only matched books in Goodreads CSV" value={options.matchedOnly} change={changeExport('matchedOnly')} />
            {!options.matchedOnly && unmatched > 0 && <p className="muted" role="status">{unmatched} unmatched {unmatched === 1 ? 'book will' : 'books will'} export by title and author. Importers may require a match.</p>}
            <Switch label="include reviews" value={options.includeReviews} change={changeExport('includeReviews')} />
            <Switch label="include notes and highlights in profile" value={options.includeNotes} change={changeExport('includeNotes')} />
            <div className="pref-actions">
              <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile('csv')}><Download size={16} aria-hidden /> Goodreads CSV</button>
              <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile('profile')}><Download size={16} aria-hidden /> Deft profile JSON</button>
            </div>
          </Panel>
          <Panel title="local backup">
            <p className="muted">A backup includes history, settings, covers and fonts. Keep your book files separately.</p>
            <div className="pref-actions">
              <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile('backup')}><Download size={16} aria-hidden /> save backup</button>
              <button className="button" disabled={Boolean(busy)} onClick={() => setConfirmation({
                label: 'restore backup', detail: 'The backup will replace your library history, notes, and settings in Deft.',
                action: () => run('restore', () => rpc<{ folders?: string[] } | boolean | null>('restoreBackup'), result => {
                  if (result) {
                    notice('Backup restored.');
                    if (typeof result === 'object' && result.folders?.length) setRestoredFolders(result.folders);
                  }
                }),
              })}><Upload size={16} aria-hidden /> restore backup</button>
            </div>
            {restoredFolders.length > 0 && <div className="pref-scan-report">
              <strong>check your library folders</strong>
              <ul>{restoredFolders.map(path => <li key={path}>{path}</li>)}</ul>
            </div>}
            <Switch label="automatic weekly backup" value={settings.backupEnabled === true} change={set('backupEnabled')} />
            <div className="pref-field"><span>backup folder</span><button className="button quiet" title={settings.backupFolder ?? ''} disabled={Boolean(busy)}
              onClick={() => void run('backup folder', () => rpc('backupFolder'))}><FolderOpen size={16} aria-hidden /> {settings.backupFolder || 'choose a folder'}</button></div>
            <Numeric label="weekly copies to keep" value={settings.backupKeep ?? 4} change={set('backupKeep')} min={1} max={52} unit="copies" />
          </Panel>
        </>}
        {section === 'storage' && <Panel title="conversion cache">
          <p className="muted">Deft keeps up to 64 recently used conversions in compressed form. Clearing this cache preserves reading positions and history.</p>
          <div className="pref-field"><span>used</span><strong className="mono">{((data.cacheBytes ?? 0) / 1_048_576).toFixed(1)} MB</strong></div>
          <Numeric label="maximum cache size" value={settings.cacheLimitMb ?? 128} change={set('cacheLimitMb')} min={16} max={16_384} unit="MB" zero="off" />
          <div className="pref-actions"><button className="button" disabled={Boolean(busy)} onClick={() => void run('cache', () => rpc('cacheClear'), () => notice('Conversion cache cleared.'))}>
            <Trash2 size={16} aria-hidden /> clear cache</button></div>
        </Panel>}
        {section === 'about' && <Panel title="about deft">
          <p>Deft is an offline ebook reader and reading tracker.</p>
          <dl className="pref-about">
            <div><dt>version</dt><dd className="mono">{version}</dd></div>
            <div><dt>license</dt><dd>GNU General Public License v3.0 only</dd></div>
            <div><dt>upstream project</dt><dd className="mono">github.com/kmab5/deft</dd></div>
            <div><dt>privacy</dt><dd>Reading history and files stay on this device. Edition matching contacts the enabled providers when requested.</dd></div>
          </dl>
          <details><summary>third-party software</summary>
            <p className="muted">Tauri, React, SQLite, PDF.js, djvu-rs, Lucide, and bundled typefaces. Full notices are in the source distribution.</p>
          </details>
        </Panel>}
      </div>
    </div>
    {confirmation && <dialog ref={confirmDialog} className="panel pref-dialog" aria-labelledby="pref-dialog-title" aria-describedby="pref-dialog-detail"
      onCancel={e => { e.preventDefault(); setConfirmation(undefined); }}
      onClick={e => {
        if (e.target !== e.currentTarget) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) setConfirmation(undefined);
      }}>
        <h2 id="pref-dialog-title">{confirmation.label}?</h2><p id="pref-dialog-detail">{confirmation.detail}</p>
        <div className="pref-actions"><button className="button quiet" autoFocus onClick={() => setConfirmation(undefined)}>cancel</button>
          <button className="button primary" onClick={() => { const action = confirmation.action; setConfirmation(undefined); void action(); }}>{confirmation.label}</button></div>
    </dialog>}
  </section>;
}

export default Settings;
