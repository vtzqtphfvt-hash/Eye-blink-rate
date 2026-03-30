import type { BlinkEvent, MinuteBin, SessionSnapshot, SessionSummary } from './types';

const ATHENS_TIME_ZONE = 'Europe/Athens';
const ATHENS_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: ATHENS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

const SESSION_HEADERS = [
  'id',
  'participantLabel',
  'sessionNotes',
  'startedAtIso',
  'endedAtIso',
  'durationMs',
  'totalBlinks',
  'overallBlinksPerMinute',
  'meanInterBlinkIntervalMs',
  'meanIntensity',
  'maxIntensity',
  'exportedAtIso'
] as const;

const BLINK_EVENT_HEADERS = [
  'id',
  'sessionId',
  'blinkIndex',
  'startMs',
  'peakMs',
  'endMs',
  'durationMs',
  'timeFromSessionStartMs',
  'wallClockIso',
  'leftEarMin',
  'rightEarMin',
  'combinedEarMin',
  'baselineEar',
  'intensity',
  'interBlinkIntervalMs'
] as const;

const MINUTE_BIN_HEADERS = [
  'id',
  'sessionId',
  'minuteIndex',
  'minuteStartMs',
  'minuteEndMs',
  'blinkCount',
  'blinksPerMinuteEquivalent'
] as const;

function escapeCsvCell(value: string | number | null): string {
  const normalized = value === null ? '' : String(value);

  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }

  return normalized;
}

function rowsToCsv(rows: Array<Array<string | number | null>>): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  URL.revokeObjectURL(url);
}

function safeTimestampLabel(isoTimestamp: string): string {
  return isoTimestamp.replaceAll(':', '-');
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60)
    .toString()
    .padStart(2, '0');
  const minutes = (absoluteMinutes % 60).toString().padStart(2, '0');

  return `${sign}${hours}:${minutes}`;
}

function formatDateForAthens(date: Date): string {
  const parts = ATHENS_DATE_TIME_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) =>
        part.type === 'year' ||
        part.type === 'month' ||
        part.type === 'day' ||
        part.type === 'hour' ||
        part.type === 'minute' ||
        part.type === 'second'
      )
      .map((part) => [part.type, part.value])
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;

  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);
  const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
  const offsetMinutes = Math.round(
    (Date.UTC(year, month - 1, day, hour, minute, second, date.getMilliseconds()) - date.getTime()) / 60_000
  );

  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${milliseconds}${formatOffset(offsetMinutes)}`;
}

function formatIsoTimestampForAthens(isoTimestamp: string | null): string | null {
  if (isoTimestamp === null) {
    return null;
  }

  const date = new Date(isoTimestamp);

  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }

  return formatDateForAthens(date);
}

function buildSessionRows(sessions: SessionSummary[]): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [Array.from(SESSION_HEADERS)];

  for (const session of sessions) {
    rows.push([
      session.id,
      session.participantLabel,
      session.sessionNotes,
      formatIsoTimestampForAthens(session.startedAtIso),
      formatIsoTimestampForAthens(session.endedAtIso),
      session.durationMs,
      session.totalBlinks,
      session.overallBlinksPerMinute,
      session.meanInterBlinkIntervalMs,
      session.meanIntensity,
      session.maxIntensity,
      formatIsoTimestampForAthens(session.exportedAtIso)
    ]);
  }

  return rows;
}

function buildBlinkEventRows(events: BlinkEvent[]): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [Array.from(BLINK_EVENT_HEADERS)];

  for (const event of events) {
    rows.push([
      event.id,
      event.sessionId,
      event.blinkIndex,
      event.startMs,
      event.peakMs,
      event.endMs,
      event.durationMs,
      event.timeFromSessionStartMs,
      formatIsoTimestampForAthens(event.wallClockIso),
      event.leftEarMin,
      event.rightEarMin,
      event.combinedEarMin,
      event.baselineEar,
      event.intensity,
      event.interBlinkIntervalMs
    ]);
  }

  return rows;
}

function buildMinuteBinRows(minuteBins: MinuteBin[]): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [Array.from(MINUTE_BIN_HEADERS)];

  for (const bin of minuteBins) {
    rows.push([
      bin.id,
      bin.sessionId,
      bin.minuteIndex,
      bin.minuteStartMs,
      bin.minuteEndMs,
      bin.blinkCount,
      bin.blinksPerMinuteEquivalent
    ]);
  }

  return rows;
}

export function getSessionCsvHeaders(): readonly string[] {
  return SESSION_HEADERS;
}

export function getBlinkEventCsvHeaders(): readonly string[] {
  return BLINK_EVENT_HEADERS;
}

export function getMinuteBinCsvHeaders(): readonly string[] {
  return MINUTE_BIN_HEADERS;
}

export function buildSessionsCsv(sessions: SessionSummary[]): string {
  return rowsToCsv(buildSessionRows(sessions));
}

export function buildBlinkEventsCsv(events: BlinkEvent[]): string {
  return rowsToCsv(buildBlinkEventRows(events));
}

export function buildMinuteBinsCsv(minuteBins: MinuteBin[]): string {
  return rowsToCsv(buildMinuteBinRows(minuteBins));
}

export function buildCurrentSessionBlinkEventsCsv(snapshot: SessionSnapshot): string {
  return buildBlinkEventsCsv(snapshot.blinkEvents);
}

export function exportCurrentSessionBlinkEventsCsv(snapshot: SessionSnapshot): void {
  downloadCsv(
    `blink-events-${safeTimestampLabel(formatIsoTimestampForAthens(snapshot.summary.startedAtIso) ?? snapshot.summary.startedAtIso)}.csv`,
    buildCurrentSessionBlinkEventsCsv(snapshot)
  );
}

export function exportAllBlinkEventsCsv(events: BlinkEvent[]): void {
  downloadCsv(`blink_events-${safeTimestampLabel(formatDateForAthens(new Date()))}.csv`, buildBlinkEventsCsv(events));
}

export function exportAllSessionSummariesCsv(sessions: SessionSummary[]): void {
  downloadCsv(`sessions-${safeTimestampLabel(formatDateForAthens(new Date()))}.csv`, buildSessionsCsv(sessions));
}

export function exportAllMinuteBinsCsv(minuteBins: MinuteBin[]): void {
  downloadCsv(`minute_bins-${safeTimestampLabel(formatDateForAthens(new Date()))}.csv`, buildMinuteBinsCsv(minuteBins));
}
