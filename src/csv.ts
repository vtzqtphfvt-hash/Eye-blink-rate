import type { BlinkEvent, MinuteBin, SessionSnapshot, SessionSummary } from './types';

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

function buildSessionRows(sessions: SessionSummary[]): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [Array.from(SESSION_HEADERS)];

  for (const session of sessions) {
    rows.push([
      session.id,
      session.participantLabel,
      session.sessionNotes,
      session.startedAtIso,
      session.endedAtIso,
      session.durationMs,
      session.totalBlinks,
      session.overallBlinksPerMinute,
      session.meanInterBlinkIntervalMs,
      session.meanIntensity,
      session.maxIntensity,
      session.exportedAtIso
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
      event.wallClockIso,
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
    `blink-events-${safeTimestampLabel(snapshot.summary.startedAtIso)}.csv`,
    buildCurrentSessionBlinkEventsCsv(snapshot)
  );
}

export function exportAllBlinkEventsCsv(events: BlinkEvent[]): void {
  downloadCsv(`blink_events-${new Date().toISOString().replaceAll(':', '-')}.csv`, buildBlinkEventsCsv(events));
}

export function exportAllSessionSummariesCsv(sessions: SessionSummary[]): void {
  downloadCsv(`sessions-${new Date().toISOString().replaceAll(':', '-')}.csv`, buildSessionsCsv(sessions));
}

export function exportAllMinuteBinsCsv(minuteBins: MinuteBin[]): void {
  downloadCsv(`minute_bins-${new Date().toISOString().replaceAll(':', '-')}.csv`, buildMinuteBinsCsv(minuteBins));
}
