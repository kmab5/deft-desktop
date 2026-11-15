import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Activity, ArrowLeft, ArrowRight, CalendarDays, Clock3, Flame, LibraryBig, Files, Trophy } from 'lucide-react';
import type { Snapshot } from './types';
import {
  addDays, bookLength, dayOfWeek, duration, finishDay, localDay, periodFor, readableDay,
  summarizePeriod, yearlyPace,
} from './statistics';
import type { Bar, Period, Range } from './statistics';
import './insights.css';

type StatsProps = {
  data: Snapshot;
  refresh?: () => void | Promise<void>;
  notice?: (message: string) => void;
  openSettings?: () => void;
};

type Icon = typeof Activity;
const OPTIONS: Range[] = ['week', 'month', 'year', 'all', 'custom'];
const count = (value: number) => new Intl.NumberFormat().format(value);
const minutes = (value: number) => value >= 60 ? duration(value) : `${Math.floor(value)}s`;
const pct = (value: number) => `${Math.round(value * 100)}%`;

function Metric({ icon: Icon, label, value, detail }: { icon: Icon; label: string; value: string | number; detail?: string }) {
  return <div className="insight-metric panel">
    <div className="insight-metric-label"><Icon size={18} aria-hidden />{label}</div>
    <strong className="mono">{typeof value === 'number' ? count(value) : value}</strong>
    {detail && <span className="muted">{detail}</span>}
  </div>;
}

function Chart({ title, bars, asTime = false, horizontal = false }: {
  title: string;
  bars: Bar[];
  asTime?: boolean;
  horizontal?: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState<number>();
  const active = activeIndex == null ? undefined : bars[activeIndex];
  let maximum = 1;
  for (const bar of bars) maximum = Math.max(maximum, bar.value);
  const pretty = asTime ? minutes : count;
  return <section className="panel insight-chart">
    <header>
      <h2>{title}</h2>
      {active && <output className="mono" aria-live="polite">{active.detail ?? active.label} · {pretty(active.value)}</output>}
    </header>
    {!bars.some(bar => bar.value > 0)
      ? <p className="muted insight-chart-empty">No data for this range.</p>
      : horizontal
        ? <div className="insight-hbars">{bars.map((bar, i) =>
          <button className="insight-hbar" key={i} aria-label={`${bar.label}, ${pretty(bar.value)}`} onClick={() => setActiveIndex(i)}>
            <span>{bar.label}</span>
            <span className="insight-hbar-rail"><span style={{ width: `${bar.value / maximum * 100}%` }} /></span>
            <span className="mono">{pretty(bar.value)}</span>
          </button>)}</div>
        : <div className="insight-chart-scroll"><div className="insight-vbars" style={{ minWidth: Math.max(0, bars.length - 7) * 21 }}>
          {bars.map((bar, i) => <button key={i} type="button" onFocus={() => setActiveIndex(i)} onClick={() => setActiveIndex(i)}
            aria-label={`${bar.detail ?? bar.label}, ${pretty(bar.value)}`} title={`${bar.detail ?? bar.label} · ${pretty(bar.value)}`}>
            <span className="insight-vbar-rail"><span style={{ height: `${bar.value / maximum * 100}%` }} /></span>
            <span className="mono">{bars.length < 15 || i % (bars.length > 25 ? 5 : 3) === 0 ? bar.label : ''}</span>
          </button>)}
        </div></div>}
  </section>;
}

function Heatmap({ period, today, summary }: { period: Period; today: string; summary: ReturnType<typeof summarizePeriod> }) {
  const [active, setActive] = useState<string>();
  const end = period.end < today ? period.end : today;
  if (period.start > end) return null;
  const cap = addDays(end, -370);
  const start = period.start > cap ? period.start : summary.firstDay && summary.firstDay > cap ? summary.firstDay : cap;
  let cursor = addDays(start, -dayOfWeek(start));
  const cells: { date: string; level: number; seconds: number; blank: boolean }[] = [];
  const months: { date: string; index: number }[] = [];
  let max = 1;
  for (const [date, entry] of summary.calendar) if (date >= start && date <= end) max = Math.max(max, entry.seconds);
  while (cursor <= end) {
    const seconds = summary.calendar.get(cursor)?.seconds ?? 0;
    const blank = cursor < start;
    const level = !blank && seconds > 0 ? Math.max(1, Math.min(4, Math.ceil(seconds / max * 4))) : 0;
    if (cells.length % 7 === 0 && (months.length === 0 || months.at(-1)?.date.slice(0, 7) !== cursor.slice(0, 7))) {
      months.push({ date: cursor < start ? start : cursor, index: cells.length / 7 });
    }
    cells.push({ date: cursor, level, seconds, blank });
    cursor = addDays(cursor, 1);
  }
  return <section className="panel insight-heatmap">
    <header><h2>reading calendar</h2><output className="mono" aria-live="polite">
      {active && active >= start && active <= end ? `${readableDay(active)} · ${minutes(summary.calendar.get(active)?.seconds ?? 0)}` : `${readableDay(start)} – ${readableDay(end)}`}
    </output></header>
    <div className="insight-heatmap-scroll">
      <div className="insight-heatmap-labels">{['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((label, i) => <span key={i}>{label}</span>)}</div>
      <div className="insight-heatmap-grid" aria-label="Reading activity by day"
        style={{ gridTemplateColumns: `repeat(${Math.ceil(cells.length / 7)}, var(--heat-cell))` }}>
        {months.map(({ date, index }) => <span className="insight-heat-month" key={date}
          style={{ left: `calc(${index} * (var(--heat-cell) + var(--heat-gap)))` }}>
          {new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))}
        </span>)}
        {cells.map(({ date, level, seconds, blank }) => blank
          ? <span key={date} />
          : <button type="button" key={date} data-level={level} tabIndex={seconds > 0 || date === today ? 0 : -1}
            onClick={() => setActive(date)} onFocus={() => setActive(date)}
            aria-label={`${readableDay(date)}, ${minutes(seconds)} read`}
            title={`${readableDay(date)} · ${minutes(seconds)} read`} />)}
      </div>
    </div>
    <div className="insight-heat-key mono"><span>less</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}<span>more</span></div>
  </section>;
}

function Review({ data, initialYear, close, rootRef }: { data: Snapshot; initialYear: number; close: () => void; rootRef: Ref<HTMLElement> }) {
  const [year, setYear] = useState(initialYear);
  const today = localDay();
  const yearNow = Number(today.slice(0, 4));
  const years = new Set([yearNow, initialYear]);
  for (const entry of data.sessions) {
    const offset = entry.zoneOffsetMinutes * 60_000;
    years.add(new Date(entry.startedAt + offset).getUTCFullYear());
    years.add(new Date(entry.endedAt + offset).getUTCFullYear());
  }
  for (const entry of data.readThroughs) {
    const day = finishDay(entry);
    if (day) years.add(Number(day.slice(0, 4)));
  }
  const summary = useMemo(() => summarizePeriod(data, { start: `${year}-01-01`, end: `${year}-12-31` }, 'year', today), [data, year, today]);
  const month = summary.busiestMonth?.label;
  return <section ref={rootRef} className="insight-page insight-review" data-motion={data.settings.celebrations !== false}>
    <div className="insight-heading">
      <button className="button quiet" onClick={close}><ArrowLeft size={17} aria-hidden /> stats</button>
      <h1>year in review</h1>
      <label className="insight-inline-control">year
        <select value={year} onChange={event => setYear(Number(event.target.value))}>
          {[...years].filter(Number.isFinite).sort((a, b) => b - a).map(value => <option key={value}>{value}</option>)}
        </select>
      </label>
    </div>
    {summary.activeSeconds === 0 && summary.finished === 0
      ? <div className="panel insight-empty"><CalendarDays aria-hidden size={28} /><h2>nothing to review yet.</h2><p>Finish a book or record a session in {year}.</p></div>
      : <>
        <article className="panel insight-review-page"><div className="mono muted">{year} · reading time</div><strong className="mono">{duration(summary.activeSeconds)}</strong><p>across {count(summary.sessionCount)} sessions</p></article>
        <article className="panel insight-review-page"><div className="mono muted">books finished</div><strong className="mono">{count(summary.finished)}</strong><p>{count(summary.pages)} pages read</p>
          {summary.topRated.length > 0 && <div className="insight-review-books" aria-label="Top rated books">{summary.topRated.map(book => <div key={book.id}>
            {(book.cover ?? book.metadata.cover) ? <img src={book.cover ?? book.metadata.cover ?? undefined} alt="" />
              : <span className="insight-review-cover"><LibraryBig size={23} aria-hidden /></span>}
            <span title={book.title}>{book.title}</span><span className="mono muted">{book.rating?.toFixed(1)} / 5</span>
          </div>)}</div>}
        </article>
        <article className="panel insight-review-page"><div className="mono muted">longest book</div>
          {summary.longestBook ? <><strong className="mono">{count(bookLength(summary.longestBook))}</strong><p>pages in {summary.longestBook.title}</p></> : <p>No page count is available for a finished book.</p>}</article>
        <article className="panel insight-review-page"><div className="mono muted">most-read author</div>
          <strong className="insight-review-text">{summary.topAuthor?.label ?? '–'}</strong>
          {summary.topAuthor && <p>{duration(summary.topAuthor.value)} spent with their books</p>}</article>
        <article className="panel insight-review-page"><div className="mono muted">busiest month</div>
          <strong className="insight-review-text">{month ? new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`)) : '–'}</strong>
          {summary.busiestMonth && <p>{duration(summary.busiestMonth.value)} read</p>}</article>
        <article className="panel insight-review-page"><div className="mono muted">favorite time to read</div><strong className="mono">{summary.favoriteHour ?? '–'}</strong><p>{summary.longestStreak} days in your longest streak</p></article>
      </>}
  </section>;
}

export function Stats({ data, openSettings }: StatsProps) {
  const today = localDay();
  const year = Number(today.slice(0, 4));
  const [range, setRange] = useState<Range>('week');
  const [custom, setCustom] = useState<Period>({ start: addDays(today, -29), end: today });
  const [review, setReview] = useState(false);
  const view = useRef<HTMLElement>(null);
  const statsScroll = useRef(0);
  useLayoutEffect(() => {
    view.current?.closest('main')?.scrollTo({ top: review ? 0 : statsScroll.current });
  }, [review]);
  const period = periodFor(range, today, custom);
  const invalid = !period.start || !period.end || period.start > period.end;
  const summary = useMemo(() => summarizePeriod(
    data,
    invalid ? { start: today, end: today } : { start: period.start, end: period.end },
    range,
    today,
  ), [data, range, period.start, period.end, today, invalid]);
  const goal = data.settings.goals?.[year];
  const yearly = useMemo(() => range === 'year' ? summary
    : summarizePeriod(data, periodFor('year', today), 'year', today), [data, range, summary, today]);
  const booksTarget = Number(goal?.booksTarget ?? 0);
  const dailyTarget = Number(goal?.dailyMinutesTarget ?? 0);
  const currentMinutes = Math.floor((yearly.calendar.get(today)?.seconds ?? 0) / 60);
  const pace = booksTarget > 0 ? yearlyPace(year, booksTarget, yearly.finished, today) : 0;
  const { records } = summary;
  const recordsList: [string, string | number][] = [
    ['longest session', records.longestSession ? minutes(records.longestSession) : '–'],
    ['most time in a day', records.longestDay ? minutes(records.longestDay) : '–'],
    ['longest book finished', records.longestBook ? `${count(records.longestBook)} pages` : '–'],
    ['fastest finish', records.fastestFinish ? `${count(records.fastestFinish)} pages / hour` : '–'],
    ['longest streak', records.longestStreak ? `${count(records.longestStreak)} days` : '–'],
    ['most books in a month', records.mostBooksInMonth || '–'],
  ];
  if (review) return <Review data={data} initialYear={year} rootRef={view} close={() => setReview(false)} />;
  return <section ref={view} className="insight-page">
    <div className="insight-heading"><h1>stats</h1>
      <div className="insight-range" aria-label="Reading statistic range">{OPTIONS.map(option =>
        <button className="button" aria-pressed={range === option} key={option} onClick={() => setRange(option)}>{option}</button>)}</div>
    </div>
    {range === 'custom' && <div className="insight-custom-range">
      <label className="insight-inline-control">from<input type="date" min="1900-01-01" max="9999-12-31" value={custom.start} onChange={e => setCustom(old => ({ ...old, start: e.target.value }))} /></label>
      <label className="insight-inline-control">through<input type="date" min="1900-01-01" max="9999-12-31" value={custom.end} onChange={e => setCustom(old => ({ ...old, end: e.target.value }))} /></label>
    </div>}
    {invalid ? <p role="alert" className="panel insight-empty">Choose a start date on or before the end date.</p> : <>
      {!summary.activeSeconds && !summary.finished && <div className="panel insight-empty"><Activity size={26} aria-hidden /><h2>no sessions in this range.</h2><p>Open a book. The clock starts itself.</p></div>}
      <div className="insight-metric-grid">
        <Metric icon={Clock3} label="time read" value={duration(summary.activeSeconds)} detail={`${summary.sessionCount} ${summary.sessionCount === 1 ? 'session' : 'sessions'}`} />
        <Metric icon={LibraryBig} label="books finished" value={summary.finished} detail={summary.abandonRate == null ? undefined : `${pct(summary.abandonRate)} abandoned`} />
        <Metric icon={Flame} label="current streak" value={`${summary.currentStreak}d`} detail={`longest in range · ${summary.longestStreak}d`} />
        <Metric icon={Files} label="pages read" value={summary.pages} detail={`${summary.pagesPerHour} pages / hour`} />
      </div>
      <Heatmap period={period} today={today} summary={summary} />
      <section className="panel insight-goals">
        <header><h2>{year} goals</h2>{openSettings && <button className="button quiet" onClick={openSettings}>settings <ArrowRight aria-hidden size={14} /></button>}</header>
        {!booksTarget && !dailyTarget ? <p className="muted">Set a yearly book or daily reading goal in settings.</p> : <div className="insight-goal-grid">
          {booksTarget > 0 && <div><div className="insight-between"><span>yearly books</span><strong className="mono">{yearly.finished} / {booksTarget}</strong></div>
            <progress max={booksTarget} value={Math.min(booksTarget, yearly.finished)} aria-label="Yearly books goal" />
            <span className="muted">{yearly.finished >= booksTarget ? 'goal reached.' : pace === 0 ? 'on schedule.' : `${Math.abs(pace)} ${pace > 0 ? 'ahead of' : 'behind'} schedule.`}</span></div>}
          {dailyTarget > 0 && <div><div className="insight-between"><span>daily minutes</span><strong className="mono">{currentMinutes} / {dailyTarget}</strong></div>
            <progress max={dailyTarget} value={Math.min(dailyTarget, currentMinutes)} aria-label="Daily reading minutes goal" />
            <span className="muted">{currentMinutes >= dailyTarget ? 'goal reached.' : `${dailyTarget - currentMinutes} minutes to go today.`}</span></div>}
        </div>}
      </section>
      <div className="insight-chart-grid">
        <Chart key={`${range}:${period.start}:${period.end}`} title="books finished" bars={summary.finishBars} />
        <Chart title="time by weekday" bars={summary.days} asTime />
        <Chart title="time of day" bars={summary.times} asTime />
        <Chart title="formats" bars={summary.formats} horizontal />
        <Chart title="book lengths · pages" bars={summary.lengths} horizontal />
        <Chart title="ratings" bars={summary.ratings} horizontal />
      </div>
      <section className="panel insight-records">
        <header><h2><Trophy size={18} aria-hidden /> personal bests</h2></header>
        <dl>{recordsList.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mono">{value}</dd></div>)}</dl>
      </section>
      <button className="panel insight-review-link" onClick={() => {
        statsScroll.current = view.current?.closest('main')?.scrollTop ?? 0;
        setReview(true);
      }}>
        <CalendarDays size={22} aria-hidden /><div><strong>year in review</strong><span className="muted">Your reading year, one story at a time.</span></div><ArrowRight size={19} aria-hidden />
      </button>
    </>}
  </section>;
}

export default Stats;
