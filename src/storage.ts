import { DB_NAME, DB_VERSION, DEFAULT_DETECTOR_SETTINGS, DETECTOR_SETTINGS_KEY } from './blink/constants';
import type { BlinkEvent, DetectorSettings, MinuteBin, SessionSummary, SessionSnapshot, SettingsEntry } from './types';

type StoreName = 'sessions' | 'blink_events' | 'minute_bins' | 'settings';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('blink_events')) {
        const store = db.createObjectStore('blink_events', { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }

      if (!db.objectStoreNames.contains('minute_bins')) {
        const store = db.createObjectStore('minute_bins', { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
  });

  return dbPromise;
}

function transactionPromise<T>(
  storeNames: StoreName[],
  mode: IDBTransactionMode,
  action: (stores: Record<StoreName, IDBObjectStore>) => T | Promise<T>
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        const stores = {
          sessions: tx.objectStore('sessions'),
          blink_events: tx.objectStore('blink_events'),
          minute_bins: tx.objectStore('minute_bins'),
          settings: tx.objectStore('settings')
        };
        let resultValue: T;
        let settled = false;

        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(resultValue);
          }
        };

        tx.onerror = () => {
          if (!settled) {
            settled = true;
            reject(tx.error ?? new Error('IndexedDB transaction failed.'));
          }
        };

        tx.onabort = () => {
          if (!settled) {
            settled = true;
            reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
          }
        };

        Promise.resolve(action(stores))
          .then((result) => {
            resultValue = result;
          })
          .catch((error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }

            try {
              tx.abort();
            } catch {
              // Ignore abort errors after the transaction is already finished.
            }
          });
      })
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function clampPositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function normalizeDetectorSettingsValue(value: unknown): DetectorSettings {
  const record = isRecord(value) ? value : {};

  return {
    closeRatio: readNumber(record, 'closeRatio', DEFAULT_DETECTOR_SETTINGS.closeRatio),
    reopenRatio: readNumber(record, 'reopenRatio', DEFAULT_DETECTOR_SETTINGS.reopenRatio),
    minimumBlinkDurationMs: clampPositiveInteger(
      readNumber(record, 'minimumBlinkDurationMs', DEFAULT_DETECTOR_SETTINGS.minimumBlinkDurationMs),
      DEFAULT_DETECTOR_SETTINGS.minimumBlinkDurationMs
    ),
    maximumBlinkDurationMs: clampPositiveInteger(
      readNumber(record, 'maximumBlinkDurationMs', DEFAULT_DETECTOR_SETTINGS.maximumBlinkDurationMs),
      DEFAULT_DETECTOR_SETTINGS.maximumBlinkDurationMs
    ),
    minimumInterBlinkGapMs: clampPositiveInteger(
      readNumber(record, 'minimumInterBlinkGapMs', DEFAULT_DETECTOR_SETTINGS.minimumInterBlinkGapMs),
      DEFAULT_DETECTOR_SETTINGS.minimumInterBlinkGapMs
    ),
    smoothingWindowSize: clampPositiveInteger(
      readNumber(record, 'smoothingWindowSize', DEFAULT_DETECTOR_SETTINGS.smoothingWindowSize),
      DEFAULT_DETECTOR_SETTINGS.smoothingWindowSize
    ),
    baselineWindowSize: clampPositiveInteger(
      readNumber(record, 'baselineWindowSize', DEFAULT_DETECTOR_SETTINGS.baselineWindowSize),
      DEFAULT_DETECTOR_SETTINGS.baselineWindowSize
    ),
    baselineSmoothingAlpha: readNumber(
      record,
      'baselineSmoothingAlpha',
      DEFAULT_DETECTOR_SETTINGS.baselineSmoothingAlpha
    ),
    baselineUpdateMinRatio: readNumber(
      record,
      'baselineUpdateMinRatio',
      DEFAULT_DETECTOR_SETTINGS.baselineUpdateMinRatio
    ),
    recoveryDeltaRatio: readNumber(record, 'recoveryDeltaRatio', DEFAULT_DETECTOR_SETTINGS.recoveryDeltaRatio),
    warmupDurationMs: clampPositiveInteger(
      readNumber(record, 'warmupDurationMs', DEFAULT_DETECTOR_SETTINGS.warmupDurationMs),
      DEFAULT_DETECTOR_SETTINGS.warmupDurationMs
    ),
    plausibleEarMin: readNumber(record, 'plausibleEarMin', DEFAULT_DETECTOR_SETTINGS.plausibleEarMin),
    plausibleEarMax: readNumber(record, 'plausibleEarMax', DEFAULT_DETECTOR_SETTINGS.plausibleEarMax),
    maxLeftRightDifference: readNumber(
      record,
      'maxLeftRightDifference',
      DEFAULT_DETECTOR_SETTINGS.maxLeftRightDifference
    ),
    maxLeftRightDifferenceDownward: readNumber(
      record,
      'maxLeftRightDifferenceDownward',
      DEFAULT_DETECTOR_SETTINGS.maxLeftRightDifferenceDownward
    ),
    maxLeftRightDifferenceDuringBlink: readNumber(
      record,
      'maxLeftRightDifferenceDuringBlink',
      DEFAULT_DETECTOR_SETTINGS.maxLeftRightDifferenceDuringBlink
    ),
    downwardPitchThresholdDeg: readNumber(
      record,
      'downwardPitchThresholdDeg',
      DEFAULT_DETECTOR_SETTINGS.downwardPitchThresholdDeg
    ),
    maxYawForStableDeg: readNumber(
      record,
      'maxYawForStableDeg',
      DEFAULT_DETECTOR_SETTINGS.maxYawForStableDeg
    ),
    maxRollForStableDeg: readNumber(
      record,
      'maxRollForStableDeg',
      DEFAULT_DETECTOR_SETTINGS.maxRollForStableDeg
    ),
    poseTransitionGuardMs: clampPositiveInteger(
      readNumber(record, 'poseTransitionGuardMs', DEFAULT_DETECTOR_SETTINGS.poseTransitionGuardMs),
      DEFAULT_DETECTOR_SETTINGS.poseTransitionGuardMs
    )
  };
}

function mergeDetectorSettingsPatch(
  baseSettings: DetectorSettings,
  patch: Partial<Record<keyof DetectorSettings, unknown>>
): DetectorSettings {
  return normalizeDetectorSettingsValue({
    ...baseSettings,
    ...patch
  });
}

function normalizeSessionSummaryRecord(value: unknown): SessionSummary {
  const record = isRecord(value) ? value : {};

  return {
    id: readString(record, 'id'),
    participantLabel: readString(record, 'participantLabel'),
    sessionNotes: readString(record, 'sessionNotes'),
    startedAtIso: readString(record, 'startedAtIso', readString(record, 'startedAt')),
    endedAtIso: readString(record, 'endedAtIso', readString(record, 'endedAt')),
    durationMs: readNumber(record, 'durationMs'),
    totalBlinks: readNumber(record, 'totalBlinks', readNumber(record, 'blinkCount')),
    overallBlinksPerMinute: readNumber(
      record,
      'overallBlinksPerMinute',
      readNumber(record, 'averageBlinksPerMinute')
    ),
    meanInterBlinkIntervalMs: readNullableNumber(record, 'meanInterBlinkIntervalMs'),
    meanIntensity: readNumber(record, 'meanIntensity'),
    maxIntensity: readNumber(record, 'maxIntensity'),
    exportedAtIso: readNullableString(record, 'exportedAtIso')
  };
}

function normalizeBlinkEventRecord(value: unknown): BlinkEvent {
  const record = isRecord(value) ? value : {};
  const peakMs = readNumber(
    record,
    'peakMs',
    readNumber(record, 'timeFromSessionStartMs', readNumber(record, 'elapsedMs'))
  );
  const startMs = readNumber(record, 'startMs', peakMs);
  const endMs = readNumber(record, 'endMs', peakMs);

  return {
    id: readString(record, 'id'),
    sessionId: readString(record, 'sessionId'),
    blinkIndex: readNumber(record, 'blinkIndex'),
    startMs,
    peakMs,
    endMs,
    durationMs: readNumber(record, 'durationMs', Math.max(0, endMs - startMs)),
    timeFromSessionStartMs: readNumber(record, 'timeFromSessionStartMs', peakMs),
    wallClockIso: readString(record, 'wallClockIso', readString(record, 'timestamp')),
    leftEarMin: readNumber(record, 'leftEarMin', readNumber(record, 'eyeAspectRatio')),
    rightEarMin: readNumber(record, 'rightEarMin', readNumber(record, 'eyeAspectRatio')),
    combinedEarMin: readNumber(record, 'combinedEarMin', readNumber(record, 'eyeAspectRatio')),
    baselineEar: readNumber(record, 'baselineEar'),
    intensity: readNumber(record, 'intensity'),
    interBlinkIntervalMs: readNullableNumber(record, 'interBlinkIntervalMs')
  };
}

function normalizeMinuteBinRecord(value: unknown): MinuteBin {
  const record = isRecord(value) ? value : {};
  const minuteStartMs = readNumber(record, 'minuteStartMs', readNumber(record, 'minuteIndex') * 60_000);
  const minuteEndMs = readNumber(record, 'minuteEndMs', minuteStartMs + readNumber(record, 'durationMs'));

  return {
    id: readString(record, 'id'),
    sessionId: readString(record, 'sessionId'),
    minuteIndex: readNumber(record, 'minuteIndex'),
    minuteStartMs,
    minuteEndMs,
    blinkCount: readNumber(record, 'blinkCount'),
    blinksPerMinuteEquivalent: readNumber(
      record,
      'blinksPerMinuteEquivalent',
      readNumber(record, 'blinksPerMinute')
    )
  };
}

function normalizeBlinkEventList(values: unknown[]): BlinkEvent[] {
  return values
    .map((entry) => normalizeBlinkEventRecord(entry))
    .sort((a, b) => {
      if (a.sessionId === b.sessionId) {
        return a.timeFromSessionStartMs - b.timeFromSessionStartMs;
      }

      return a.sessionId.localeCompare(b.sessionId);
    })
    .map((event, index, array) => {
      if (event.blinkIndex > 0) {
        return event;
      }

      const previous = array[index - 1];
      const blinkIndex = previous && previous.sessionId === event.sessionId ? previous.blinkIndex + 1 : 1;
      return {
        ...event,
        blinkIndex
      };
    });
}

function computeSessionMetrics(durationMs: number, blinkEvents: BlinkEvent[]) {
  const totalBlinks = blinkEvents.length;
  const overallBlinksPerMinute = durationMs > 0 ? (totalBlinks / durationMs) * 60_000 : 0;
  const interBlinkIntervals = blinkEvents
    .map((event) => event.interBlinkIntervalMs)
    .filter((value): value is number => value !== null);
  const intensities = blinkEvents.map((event) => event.intensity).filter((value) => Number.isFinite(value));

  return {
    totalBlinks,
    overallBlinksPerMinute,
    meanInterBlinkIntervalMs:
      interBlinkIntervals.length > 0
        ? interBlinkIntervals.reduce((sum, value) => sum + value, 0) / interBlinkIntervals.length
        : null,
    meanIntensity: intensities.length > 0 ? intensities.reduce((sum, value) => sum + value, 0) / intensities.length : 0,
    maxIntensity: intensities.length > 0 ? Math.max(...intensities) : 0
  };
}

function deriveSessionSummary(baseSummary: SessionSummary, blinkEvents: BlinkEvent[]): SessionSummary {
  const durationMs = Math.max(0, baseSummary.durationMs);
  const metrics = computeSessionMetrics(durationMs, blinkEvents);

  return {
    id: baseSummary.id,
    participantLabel: baseSummary.participantLabel,
    sessionNotes: baseSummary.sessionNotes,
    startedAtIso: baseSummary.startedAtIso,
    endedAtIso: baseSummary.endedAtIso,
    durationMs,
    totalBlinks: metrics.totalBlinks,
    overallBlinksPerMinute: metrics.overallBlinksPerMinute,
    meanInterBlinkIntervalMs: metrics.meanInterBlinkIntervalMs,
    meanIntensity: metrics.meanIntensity,
    maxIntensity: metrics.maxIntensity,
    exportedAtIso: baseSummary.exportedAtIso
  };
}

export async function initStorage(): Promise<void> {
  await openDatabase();
}

export async function saveSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const normalizedSummary = deriveSessionSummary(snapshot.summary, snapshot.blinkEvents);

  await transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readwrite', async (stores) => {
    stores.sessions.put(normalizedSummary);

    for (const event of snapshot.blinkEvents) {
      stores.blink_events.put(event);
    }

    for (const bin of snapshot.minuteBins) {
      stores.minute_bins.put(bin);
    }
  });
}

export async function listSessions(): Promise<SessionSummary[]> {
  return transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readonly', async (stores) => {
    const [sessionRows, eventRows] = await Promise.all([
      requestToPromise(stores.sessions.getAll()),
      requestToPromise(stores.blink_events.getAll())
    ]);
    const normalizedEvents = normalizeBlinkEventList(eventRows);
    const eventsBySessionId = new Map<string, BlinkEvent[]>();

    for (const event of normalizedEvents) {
      const existing = eventsBySessionId.get(event.sessionId) ?? [];
      existing.push(event);
      eventsBySessionId.set(event.sessionId, existing);
    }

    return sessionRows
      .map((entry) => normalizeSessionSummaryRecord(entry))
      .map((summary) => deriveSessionSummary(summary, eventsBySessionId.get(summary.id) ?? []))
      .sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso));
  });
}

export async function getBlinkEventsForSession(sessionId: string): Promise<BlinkEvent[]> {
  return transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readonly', async (stores) => {
    const index = stores.blink_events.index('sessionId');
    const events = await requestToPromise(index.getAll(IDBKeyRange.only(sessionId)));
    return normalizeBlinkEventList(events).filter((event) => event.sessionId === sessionId);
  });
}

export async function listAllBlinkEvents(): Promise<BlinkEvent[]> {
  return transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readonly', async (stores) => {
    const [events, sessionRows] = await Promise.all([
      requestToPromise(stores.blink_events.getAll()),
      requestToPromise(stores.sessions.getAll())
    ]);

    const sessionStartMap = new Map<string, string>();
    for (const row of sessionRows) {
      const summary = normalizeSessionSummaryRecord(row);
      sessionStartMap.set(summary.id, summary.startedAtIso);
    }

    const normalizedEvents = normalizeBlinkEventList(events);

    return normalizedEvents.sort((a, b) => {
      if (a.sessionId === b.sessionId) {
        return a.timeFromSessionStartMs - b.timeFromSessionStartMs;
      }

      const startA = sessionStartMap.get(a.sessionId) ?? '';
      const startB = sessionStartMap.get(b.sessionId) ?? '';

      const sessionCmp = startB.localeCompare(startA);
      if (sessionCmp !== 0) {
        return sessionCmp;
      }

      return a.sessionId.localeCompare(b.sessionId);
    });
  });
}

export async function getMinuteBinsForSession(sessionId: string): Promise<MinuteBin[]> {
  return transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readonly', async (stores) => {
    const index = stores.minute_bins.index('sessionId');
    const bins = await requestToPromise(index.getAll(IDBKeyRange.only(sessionId)));
    return bins
      .map((entry) => normalizeMinuteBinRecord(entry))
      .filter((bin) => bin.sessionId === sessionId)
      .sort((a, b) => a.minuteIndex - b.minuteIndex);
  });
}

export async function listAllMinuteBins(): Promise<MinuteBin[]> {
  return transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readonly', async (stores) => {
    const [bins, sessionRows] = await Promise.all([
      requestToPromise(stores.minute_bins.getAll()),
      requestToPromise(stores.sessions.getAll())
    ]);

    const sessionStartMap = new Map<string, string>();
    for (const row of sessionRows) {
      const summary = normalizeSessionSummaryRecord(row);
      sessionStartMap.set(summary.id, summary.startedAtIso);
    }

    return bins
      .map((entry) => normalizeMinuteBinRecord(entry))
      .sort((a, b) => {
        if (a.sessionId === b.sessionId) {
          return a.minuteIndex - b.minuteIndex;
        }

        const startA = sessionStartMap.get(a.sessionId) ?? '';
        const startB = sessionStartMap.get(b.sessionId) ?? '';

        const sessionCmp = startB.localeCompare(startA);
        if (sessionCmp !== 0) {
          return sessionCmp;
        }

        return a.sessionId.localeCompare(b.sessionId);
      });
  });
}

export async function getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  return transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readonly', async (stores) => {
    const [summaryRow, blinkEvents, minuteBins] = await Promise.all([
      requestToPromise(stores.sessions.get(sessionId)),
      requestToPromise(stores.blink_events.index('sessionId').getAll(IDBKeyRange.only(sessionId))),
      requestToPromise(stores.minute_bins.index('sessionId').getAll(IDBKeyRange.only(sessionId)))
    ]);

    if (summaryRow === undefined) {
      return null;
    }

    const summary = deriveSessionSummary(normalizeSessionSummaryRecord(summaryRow), normalizeBlinkEventList(blinkEvents));

    return {
      summary,
      blinkEvents: normalizeBlinkEventList(blinkEvents).filter((event) => event.sessionId === sessionId),
      minuteBins: minuteBins
        .map((entry) => normalizeMinuteBinRecord(entry))
        .filter((bin) => bin.sessionId === sessionId)
        .sort((a, b) => a.minuteIndex - b.minuteIndex)
    };
  });
}

export async function markSessionsExported(sessionIds: string[], exportedAtIso: string): Promise<void> {
  const uniqueSessionIds = [...new Set(sessionIds)];

  if (uniqueSessionIds.length === 0) {
    return;
  }

  await transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readwrite', async (stores) => {
    for (const sessionId of uniqueSessionIds) {
      const [existing, eventRows] = await Promise.all([
        requestToPromise(stores.sessions.get(sessionId)),
        requestToPromise(stores.blink_events.index('sessionId').getAll(IDBKeyRange.only(sessionId)))
      ]);

      if (existing === undefined) {
        continue;
      }

      const normalized = deriveSessionSummary(normalizeSessionSummaryRecord(existing), normalizeBlinkEventList(eventRows));
      stores.sessions.put({
        ...normalized,
        exportedAtIso
      });
    }
  });
}

export async function clearRecordedData(): Promise<void> {
  await transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readwrite', async (stores) => {
    stores.sessions.clear();
    stores.blink_events.clear();
    stores.minute_bins.clear();
  });
}

export async function loadDetectorSettings(): Promise<DetectorSettings> {
  return transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readonly', async (stores) => {
    const [detectorSettingsRow, settingRows] = await Promise.all([
      requestToPromise(stores.settings.get(DETECTOR_SETTINGS_KEY)),
      requestToPromise(stores.settings.getAll())
    ]);

    if (detectorSettingsRow !== undefined) {
      const record = isRecord(detectorSettingsRow) ? detectorSettingsRow : {};
      return normalizeDetectorSettingsValue(record.value);
    }

    let mergedSettings = { ...DEFAULT_DETECTOR_SETTINGS };

    for (const row of settingRows) {
      const record = isRecord(row) ? row : {};
      const key = readString(record, 'key');

      if (!key || !(key in DEFAULT_DETECTOR_SETTINGS)) {
        continue;
      }

      mergedSettings = mergeDetectorSettingsPatch(mergedSettings, {
        [key]: record.value
      } as Partial<Record<keyof DetectorSettings, unknown>>);
    }

    return mergedSettings;
  });
}

export async function saveDetectorSettings(settings: DetectorSettings): Promise<void> {
  await saveSetting({
    key: DETECTOR_SETTINGS_KEY,
    value: normalizeDetectorSettingsValue(settings)
  });
}

export async function saveSetting(entry: SettingsEntry): Promise<void> {
  await transactionPromise(['sessions', 'blink_events', 'minute_bins', 'settings'], 'readwrite', async (stores) => {
    stores.settings.put(entry);
  });
}
