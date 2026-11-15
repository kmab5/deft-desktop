import type { Snapshot } from './types';

type Book = Snapshot['books'][number];
type Session = Snapshot['sessions'][number];
type ReadThrough = Snapshot['readThroughs'][number];

export type Period = { start: string; end: string };
export type Range = 'week' | 'month' | 'year' | 'all' | 'custom';
export type CalendarDay = { date: string; seconds: number; pages: number };
export type Bar = { label: string; value: number; detail?: string };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function duration(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes}m`;
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function localDay(date = new Date()) {
  return dayFromMs(date.getTime() - date.getTimezoneOffset() * 60_000);
}

export function dayFromMs(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

export function dayToMs(value: string) {
  return Date.parse(`${value}T00:00:00Z`);
}

export function addDays(date: string, days: number) {
  return dayFromMs(dayToMs(date) + days * DAY_MS);
}

export function dayOfWeek(value: string) {
  return (new Date(dayToMs(value)).getUTCDay() + 6) % 7;
}

export function readableDay(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(dayToMs(value));
}

export function periodFor(range: Range, today = localDay(), custom?: Period): Period {
  const year = today.slice(0, 4);
  switch (range) {
    case 'week': {
      const start = addDays(today, -dayOfWeek(today));
      return { start, end: addDays(start, 6) };
    }
    case 'month': {
      const start = `${today.slice(0, 7)}-01`;
      const next = new Date(dayToMs(start));
      next.setUTCMonth(next.getUTCMonth() + 1);
      return { start, end: addDays(dayFromMs(next.getTime()), -1) };
    }
    case 'year':
      return { start: `${year}-01-01`, end: `${year}-12-31` };
    case 'all':
      return { start: '1900-01-01', end: '9999-12-31' };
    case 'custom':
      return custom ?? { start: today, end: today };
  }
}

export function isWithin(date: string, period: Period) {
  return date >= period.start && date <= period.end;
}

export function finishDay(entry: ReadThrough) {
  if (entry.endedAt == null) return undefined;
  return dayFromMs(entry.endedAt + (entry.zoneOffsetMinutes ?? 0) * 60_000);
}

export function sessionPages(session: Session) {
  const start = session.startLocator;
  const end = session.endLocator;
  if (!start || !end) return 0;
  return Math.abs((end.page ?? end.position ?? 0) - (start.page ?? start.position ?? 0));
}

export function bookLength(book: Book) {
  return book.pageCount ?? book.metadata.pageCount ?? 0;
}

export function sessionDays(
  session: Session,
  visit: (date: string, hour: number, seconds: number, pages: number) => void,
) {
  const offset = (session.zoneOffsetMinutes ?? 0) * 60_000;
  const end = session.endedAt + offset;
  const elapsed = session.endedAt - session.startedAt;
  const activeMs = Math.max(0, (session.activeSeconds ?? 0) * 1_000);
  if (!Number.isFinite(end) || !Number.isFinite(activeMs) || !activeMs) return;
  // Only cumulative active time is stored. Weight a checkpoint by elapsed wall time
  // so current calendar totals preserve active time even across midnight or an idle gap.
  const span = elapsed > 0 ? Math.min(elapsed, 7 * DAY_MS) : activeMs;
  let cursor = end - span;
  const pages = sessionPages(session);
  while (cursor < end) {
    const hourBoundary = Math.floor(cursor / HOUR_MS) * HOUR_MS + HOUR_MS;
    const next = Math.min(end, hourBoundary);
    const share = (next - cursor) / span;
    visit(dayFromMs(cursor), new Date(cursor).getUTCHours(), activeMs * share / 1_000, pages * share);
    cursor = next;
  }
}

function accepted(data: Snapshot) {
  const books = data.books.filter(book => !book.ignored);
  const ids = new Set(books.map(book => book.id));
  const sessions = data.sessions.filter(session => !session.browsing && ids.has(session.bookId));
  const throughs = data.readThroughs.filter(through => ids.has(through.bookId));
  return { books, sessions, throughs };
}

function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function chart(map: Map<string, number>, byValue = true): Bar[] {
  const rows = [...map].map(([label, value]) => ({ label, value }));
  return byValue ? rows.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)) : rows;
}

function finiteMax(values: Iterable<number>) {
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  return max;
}

function rate(pages: number, seconds: number) {
  return seconds > 0 ? pages * 3_600 / seconds : 0;
}

function streak(daily: Map<string, number>, threshold: number, period: Period, today: string) {
  const days = [...daily]
    .filter(([date, seconds]) => date <= today && seconds + 0.001 >= threshold)
    .map(([date]) => date)
    .sort();
  let longest = 0;
  let counting = 0;
  let rangeCount = 0;
  let last: string | undefined;
  for (const date of days) {
    const consecutive = last != null && addDays(last, 1) === date;
    counting = consecutive ? counting + 1 : 1;
    rangeCount = isWithin(date, period) ? (consecutive ? rangeCount + 1 : 1) : 0;
    longest = Math.max(longest, rangeCount);
    last = date;
  }
  return { current: last && (last === today || last === addDays(today, -1)) ? counting : 0, longest };
}

function periodChart(finishes: Map<string, number>, period: Period, range: Range): Bar[] {
  const dayCount = (dayToMs(period.end) - dayToMs(period.start)) / DAY_MS + 1;
  if (range === 'all') {
    const years = new Map<string, number>();
    for (const [day, value] of finishes) add(years, day.slice(0, 4), value);
    return chart(new Map([...years].sort()), false);
  }
  if (dayCount <= 35) {
    return Array.from({ length: Math.max(0, dayCount) }, (_, i) => {
      const date = addDays(period.start, i);
      return { label: dayCount <= 7 ? DAYS[dayOfWeek(date)] : date.slice(-2), value: finishes.get(date) ?? 0, detail: readableDay(date) };
    });
  }
  if (dayCount > 1_100) {
    const years = new Map<string, number>();
    for (const [day, value] of finishes) add(years, day.slice(0, 4), value);
    return chart(new Map([...years].sort()), false);
  }
  const months = new Map<string, number>();
  const start = new Date(dayToMs(`${period.start.slice(0, 7)}-01`));
  while (dayFromMs(start.getTime()) <= period.end) {
    months.set(dayFromMs(start.getTime()).slice(0, 7), 0);
    start.setUTCMonth(start.getUTCMonth() + 1);
  }
  for (const [day, value] of finishes) add(months, day.slice(0, 7), value);
  return [...months].map(([month, value]) => ({
    label: MONTHS[Number(month.slice(5, 7)) - 1],
    value,
    detail: month,
  }));
}

export function summarizeBook(data: Snapshot, bookId: string) {
  const { books, sessions, throughs } = accepted(data);
  const book = books.find(entry => entry.id === bookId);
  const entries = throughs.filter(entry => entry.bookId === bookId);
  const history = sessions.filter(entry => entry.bookId === bookId);
  const activeSeconds = history.reduce((sum, session) => sum + session.activeSeconds, 0);
  const pages = history.reduce((sum, session) => sum + sessionPages(session), 0);
  const pagesPerHour = rate(pages, activeSeconds);
  const overallSpeed = rate(
    sessions.reduce((sum, session) => sum + sessionPages(session), 0),
    sessions.reduce((sum, session) => sum + session.activeSeconds, 0),
  );
  const speed = pagesPerHour || overallSpeed;
  const size = book ? bookLength(book) || (book.progress > 0 && book.locator?.position ? book.locator.position / book.progress : 0) : 0;
  const finished = entries.filter(entry => entry.outcome === 'finished');
  return {
    activeSeconds,
    sessions: history.length,
    averageSeconds: history.length ? activeSeconds / history.length : 0,
    pages,
    pagesPerHour,
    estimateSeconds: size && speed && book ? Math.max(0, 1 - book.progress) * size / speed * 3_600 : undefined,
    finished: finished.length,
    firstStart: entries.length ? Math.min(...entries.map(entry => entry.startedAt)) : undefined,
    lastFinish: finished.length ? Math.max(...finished.map(entry => entry.endedAt ?? entry.startedAt)) : undefined,
  };
}

export function summarizeBooks(data: Snapshot, bookIds: Iterable<string>) {
  const ids = new Set(bookIds);
  const { books, sessions } = accepted(data);
  const selected = books.filter(book => ids.has(book.id));
  const rated = selected.filter(book => book.rating != null && book.rating > 0);
  const states = { finished: 0, reading: 0, paused: 0, abandoned: 0, unread: 0 };
  for (const book of selected) {
    switch (book.state) {
      case 'finished':
      case 'reading':
      case 'paused':
      case 'abandoned':
        states[book.state]++;
        break;
      default:
        states.unread++;
    }
  }
  return {
    total: selected.length,
    ...states,
    activeSeconds: sessions.filter(session => ids.has(session.bookId))
      .reduce((seconds, session) => seconds + session.activeSeconds, 0),
    rating: rated.length ? rated.reduce((sum, book) => sum + (book.rating ?? 0), 0) / rated.length : undefined,
  };
}

export function summarizePeriod(
  data: Snapshot,
  period: Period,
  range: Range,
  today = localDay(),
) {
  const { books, sessions, throughs } = accepted(data);
  const stableToday = period.end < today ? period.end : today;
  const allDaily = new Map<string, number>();
  const calendar = new Map<string, CalendarDay>();
  const bookTime = new Map<string, number>();
  const attemptPace = new Map<string, { pages: number; seconds: number }>();
  const monthlyTime = new Map<string, number>();
  const dayTime = new Array<number>(7).fill(0);
  const hourlyTime = new Array<number>(24).fill(0);
  let sessionCount = 0;
  let longestSession = 0;
  let activeSeconds = 0;
  let pages = 0;
  for (const session of sessions) {
    let included = 0;
    let includedPages = 0;
    sessionDays(session, (date, hour, seconds, pageCount) => {
      add(allDaily, date, seconds);
      if (!isWithin(date, period)) return;
      const previous = calendar.get(date);
      calendar.set(date, { date, seconds: (previous?.seconds ?? 0) + seconds, pages: (previous?.pages ?? 0) + pageCount });
      add(monthlyTime, date.slice(0, 7), seconds);
      dayTime[dayOfWeek(date)] += seconds;
      hourlyTime[hour] += seconds;
      included += seconds;
      includedPages += pageCount;
    });
    const priorAttempt = attemptPace.get(session.readThroughId);
    attemptPace.set(session.readThroughId, {
      seconds: (priorAttempt?.seconds ?? 0) + session.activeSeconds,
      pages: (priorAttempt?.pages ?? 0) + sessionPages(session),
    });
    if (!included) continue;
    sessionCount++;
    longestSession = Math.max(longestSession, included);
    activeSeconds += included;
    pages += includedPages;
    add(bookTime, session.bookId, included);
  }
  const finishes = new Map<string, number>();
  const monthlyFinishes = new Map<string, number>();
  const finishedIds = new Set<string>();
  let finished = 0;
  let abandoned = 0;
  let fastestFinish = 0;
  for (const attempt of throughs) {
    if (attempt.outcome !== 'finished' && attempt.outcome !== 'abandoned') continue;
    const date = finishDay(attempt);
    if (!date || !isWithin(date, period)) continue;
    if (attempt.outcome === 'finished') {
      finished++;
      finishedIds.add(attempt.bookId);
      add(finishes, date, 1);
      add(monthlyFinishes, date.slice(0, 7), 1);
      const pace = attemptPace.get(attempt.id);
      if (pace && pace.pages >= 100) fastestFinish = Math.max(fastestFinish, rate(pace.pages, pace.seconds));
    } else {
      abandoned++;
    }
  }
  const formats = new Map<string, number>();
  const lengths = new Map([['1–99', 0], ['100–249', 0], ['250–499', 0], ['500+', 0]]);
  const ratings = new Map<string, number>();
  const authorTime = new Map<string, number>();
  const completed = books.filter(book => finishedIds.has(book.id));
  const relevant = books.filter(book => bookTime.has(book.id) || finishedIds.has(book.id) || (range === 'all'));
  for (const book of relevant) {
    add(formats, book.format.toUpperCase(), 1);
    const length = bookLength(book);
    if (length > 0) add(lengths, length < 100 ? '1–99' : length < 250 ? '100–249' : length < 500 ? '250–499' : '500+', 1);
    if (book.rating != null && book.rating > 0) add(ratings, book.rating.toFixed(1), 1);
    const seconds = bookTime.get(book.id) ?? 0;
    if (seconds) for (const author of book.authors) add(authorTime, author, seconds);
  }
  const streaks = streak(allDaily, Math.max(1, Number(data.settings.streakMinutes ?? 1)) * 60, period, stableToday);
  const longestBook = [...completed].sort((a, b) => bookLength(b) - bookLength(a))[0];
  const topRated = [...completed].filter(book => book.rating).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.title.localeCompare(b.title));
  const times = hourlyTime.map((seconds, hour) => ({ label: `${String(hour).padStart(2, '0')}:00`, value: seconds }));
  const firstDay = [...calendar.keys()].sort()[0];
  return {
    activeSeconds, pages: Math.round(pages), finished, abandoned, sessionCount,
    pagesPerHour: Math.round(rate(pages, activeSeconds)),
    currentStreak: streaks.current, longestStreak: streaks.longest,
    abandonRate: finished + abandoned ? abandoned / (finished + abandoned) : undefined,
    firstDay,
    calendar,
    allDaily,
    finishBars: periodChart(finishes, period, range),
    formats: chart(formats),
    lengths: chart(lengths, false),
    ratings: chart(new Map([...ratings].sort()), false),
    days: dayTime.map((value, i) => ({ label: DAYS[i], value })),
    times,
    topRated: topRated.slice(0, 5),
    longestBook: longestBook && bookLength(longestBook) ? longestBook : undefined,
    topAuthor: chart(authorTime)[0],
    busiestMonth: chart(monthlyTime)[0],
    favoriteHour: [...times].sort((a, b) => b.value - a.value).find(item => item.value > 0)?.label,
    records: {
      longestSession, longestDay: finiteMax([...calendar.values()].map(day => day.seconds)),
      longestBook: longestBook ? bookLength(longestBook) : 0,
      fastestFinish: Math.round(fastestFinish),
      longestStreak: streaks.longest,
      mostBooksInMonth: finiteMax(monthlyFinishes.values()),
    },
  };
}

export function yearlyPace(year: number, target: number, completed: number, today = localDay()) {
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  const dayCount = (dayToMs(last) - dayToMs(first)) / DAY_MS + 1;
  const elapsed = Math.max(0, Math.min(dayCount, (dayToMs(today) - dayToMs(first)) / DAY_MS + 1));
  return completed - Math.floor(elapsed * target / dayCount);
}
