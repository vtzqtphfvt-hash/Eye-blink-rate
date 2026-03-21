import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { CameraController } from './camera';
import { DEFAULT_DETECTOR_SETTINGS } from './blink/constants';
import { BlinkDetector } from './blink/detector';
import { computeEarReadings, estimateEyeGaze, estimateHeadPose } from './blink/ear';
import {
  exportAllBlinkEventsCsv,
  exportAllMinuteBinsCsv,
  exportAllSessionSummariesCsv,
  exportCurrentSessionBlinkEventsCsv
} from './csv';
import { loadFaceLandmarker } from './mediapipe';
import {
  clearRecordedData,
  getSessionSnapshot,
  initStorage,
  listAllBlinkEvents,
  listAllMinuteBins,
  listSessions,
  loadDetectorSettings,
  markSessionsExported,
  saveDetectorSettings,
  saveSessionSnapshot
} from './storage';
import type {
  BlinkEvent,
  DetectorSettings,
  LiveDebugMetrics,
  MinuteBin,
  SessionSnapshot,
  SessionSummary,
  TrackingQualityState,
  TrackingState
} from './types';

interface ActiveSession {
  id: string;
  startedAtMs: number;
  startedAtIso: string;
  participantLabel: string;
  sessionNotes: string;
  blinkEvents: BlinkEvent[];
}

interface SettingField {
  key: keyof DetectorSettings;
  label: string;
  description: string;
  step: string;
  min?: number;
  max?: number;
}

const SETTING_FIELDS: SettingField[] = [
  { key: 'closeRatio', label: 'closeRatio', description: 'Baseline multiplier to enter blink closing.', step: '0.01', min: 0.1, max: 1.2 },
  { key: 'reopenRatio', label: 'reopenRatio', description: 'Baseline multiplier required to finish reopening.', step: '0.01', min: 0.1, max: 1.4 },
  { key: 'minimumBlinkDurationMs', label: 'minimumBlinkDurationMs', description: 'Shortest blink duration counted as valid.', step: '1', min: 1 },
  { key: 'maximumBlinkDurationMs', label: 'maximumBlinkDurationMs', description: 'Longest closure still counted as a blink.', step: '1', min: 1 },
  { key: 'minimumInterBlinkGapMs', label: 'minimumInterBlinkGapMs', description: 'Required gap after a completed blink.', step: '1', min: 0 },
  { key: 'smoothingWindowSize', label: 'smoothingWindowSize', description: 'Frames averaged for EAR smoothing.', step: '1', min: 1 },
  { key: 'baselineWindowSize', label: 'baselineWindowSize', description: 'Stable frames used to estimate baseline EAR.', step: '1', min: 1 },
  { key: 'baselineSmoothingAlpha', label: 'baselineSmoothingAlpha', description: 'EMA weight for updating baseline EAR.', step: '0.01', min: 0.01, max: 1 },
  { key: 'baselineUpdateMinRatio', label: 'baselineUpdateMinRatio', description: 'Skip baseline updates below this baseline fraction.', step: '0.01', min: 0.1, max: 1.2 },
  { key: 'recoveryDeltaRatio', label: 'recoveryDeltaRatio', description: 'EAR recovery amount needed before reopening.', step: '0.001', min: 0, max: 0.2 },
  { key: 'warmupDurationMs', label: 'warmupDurationMs', description: 'Warm-up time used to establish baseline EAR.', step: '1', min: 0 },
  { key: 'plausibleEarMin', label: 'plausibleEarMin', description: 'Reject frames below this EAR as implausible.', step: '0.01', min: 0, max: 1 },
  { key: 'plausibleEarMax', label: 'plausibleEarMax', description: 'Reject frames above this EAR as implausible.', step: '0.01', min: 0, max: 1 },
  { key: 'maxLeftRightDifference', label: 'maxLeftRightDifference', description: 'Reject open-eye frames with excessive left/right EAR mismatch.', step: '0.01', min: 0, max: 1 },
  { key: 'maxLeftRightDifferenceDownward', label: 'maxLeftRightDifferenceDownward', description: 'Looser open-eye asymmetry tolerance allowed for downward pose.', step: '0.01', min: 0, max: 1 },
  { key: 'maxLeftRightDifferenceDuringBlink', label: 'maxLeftRightDifferenceDuringBlink', description: 'Looser asymmetry tolerance allowed once a blink is plausibly underway.', step: '0.01', min: 0, max: 1 },
  { key: 'downwardPitchThresholdDeg', label: 'downwardPitchThresholdDeg', description: 'Pitch threshold used to bucket pose as downward.', step: '1', min: -45, max: 45 },
  { key: 'maxYawForStableDeg', label: 'maxYawForStableDeg', description: 'Maximum yaw allowed for stable tracking and baseline updates.', step: '1', min: 0, max: 90 },
  { key: 'maxRollForStableDeg', label: 'maxRollForStableDeg', description: 'Maximum roll allowed for stable tracking and baseline updates.', step: '1', min: 0, max: 90 },
  { key: 'poseTransitionGuardMs', label: 'poseTransitionGuardMs', description: 'Blocks new blink entry briefly after a pose bucket switch.', step: '1', min: 0, max: 2000 }
];

function createSettingsMarkup(): string {
  return SETTING_FIELDS.map(
    (field) => `
      <label class="settings-field">
        <span class="settings-label">${field.label}</span>
        <input
          type="number"
          data-setting-key="${field.key}"
          step="${field.step}"
          ${field.min !== undefined ? `min="${field.min}"` : ''}
          ${field.max !== undefined ? `max="${field.max}"` : ''}
        />
        <span class="settings-help">${field.description}</span>
      </label>
    `
  ).join('');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundPositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function sanitizeDetectorSettings(settings: DetectorSettings): DetectorSettings {
  const plausibleEarMin = clamp(settings.plausibleEarMin, 0, 1);
  const plausibleEarMax = clamp(Math.max(settings.plausibleEarMax, plausibleEarMin + 0.01), 0.01, 1);
  const closeRatio = clamp(settings.closeRatio, 0.1, 1.2);
  const reopenRatio = clamp(Math.max(settings.reopenRatio, closeRatio + 0.02), 0.1, 1.4);
  const minimumBlinkDurationMs = roundPositiveInteger(
    settings.minimumBlinkDurationMs,
    DEFAULT_DETECTOR_SETTINGS.minimumBlinkDurationMs
  );
  const maximumBlinkDurationMs = Math.max(
    roundPositiveInteger(settings.maximumBlinkDurationMs, DEFAULT_DETECTOR_SETTINGS.maximumBlinkDurationMs),
    minimumBlinkDurationMs + 1
  );
  const minimumInterBlinkGapMs = Math.max(0, Math.round(settings.minimumInterBlinkGapMs));

  return {
    closeRatio,
    reopenRatio,
    minimumBlinkDurationMs,
    maximumBlinkDurationMs,
    minimumInterBlinkGapMs,
    smoothingWindowSize: Math.max(1, Math.round(settings.smoothingWindowSize)),
    baselineWindowSize: Math.max(1, Math.round(settings.baselineWindowSize)),
    baselineSmoothingAlpha: clamp(settings.baselineSmoothingAlpha, 0.01, 1),
    baselineUpdateMinRatio: clamp(settings.baselineUpdateMinRatio, 0.1, 1.2),
    recoveryDeltaRatio: clamp(settings.recoveryDeltaRatio, 0, 0.2),
    warmupDurationMs: Math.max(0, Math.round(settings.warmupDurationMs)),
    plausibleEarMin,
    plausibleEarMax,
    maxLeftRightDifference: clamp(settings.maxLeftRightDifference, 0, 1),
    maxLeftRightDifferenceDownward: clamp(settings.maxLeftRightDifferenceDownward, 0, 1),
    maxLeftRightDifferenceDuringBlink: clamp(settings.maxLeftRightDifferenceDuringBlink, 0, 1),
    downwardPitchThresholdDeg: clamp(settings.downwardPitchThresholdDeg, -45, 45),
    maxYawForStableDeg: clamp(settings.maxYawForStableDeg, 0, 90),
    maxRollForStableDeg: clamp(settings.maxRollForStableDeg, 0, 90),
    poseTransitionGuardMs: Math.max(0, Math.round(settings.poseTransitionGuardMs))
  };
}

function createEmptyDebugMetrics(): LiveDebugMetrics {
  return {
    pitchDeg: 0,
    yawDeg: 0,
    rollDeg: 0,
    poseBucket: 'forward',
    timeSinceLastPoseBucketSwitchMs: 0,
    poseTransitionGuardActive: false,
    gazeShiftVetoActive: false,
    blinkEntryBlockedByPoseStabilization: false,
    leftEar: 0,
    rightEar: 0,
    combinedEar: 0,
    smoothedEar: 0,
    earDifference: 0,
    baselineEar: 0,
    baselineForwardEar: 0,
    baselineDownwardEar: 0,
    activeBaselineEar: 0,
    detectorState: 'idle',
    trackingQualityState: 'no_face',
    asymmetryRejectionActive: false,
    blinkPhaseAsymmetryToleranceActive: false,
    elapsedSessionMs: 0,
    totalBlinkCount: 0,
    overallBlinksPerMinute: 0,
    lastBlinkTimestampMs: null
  };
}

export async function mountApp(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">Local only</p>
          <h1>Blink Tracker</h1>
          <p class="subtitle">Runs fully in your browser on localhost. Webcam, rolling-baseline EAR detector, local persistence, CSV export, and tuneable detector settings.</p>
        </div>
      </header>

      <section class="layout">
        <section class="panel video-panel" aria-labelledby="preview-heading">
          <div class="panel-header">
            <h2 id="preview-heading">Webcam Preview</h2>
            <div class="chip-row">
              <span id="tracking-status" class="status-chip">Idle</span>
              <span id="quality-status" class="status-chip quality-chip">no_face</span>
            </div>
          </div>
          <video id="webcam" autoplay muted playsinline></video>
          <p id="camera-message" class="muted">Requesting webcam access...</p>
          <div class="session-meta-form" aria-label="Session metadata">
            <label class="meta-field">
              <span class="settings-label">Participant label</span>
              <input id="participant-label-input" type="text" maxlength="80" placeholder="e.g. P01 morning trial" />
            </label>
            <label class="meta-field">
              <span class="settings-label">Session notes</span>
              <textarea id="session-notes-input" rows="3" maxlength="500" placeholder="Optional notes for repeated trials or pilot runs"></textarea>
            </label>
          </div>
          <div class="controls">
            <button id="start-button" type="button">Start</button>
            <button id="stop-button" type="button" disabled>Stop</button>
            <button id="export-current-button" type="button">Export Current Session Blink Events CSV</button>
          </div>
          <p id="start-status-message" class="muted control-note">Camera not ready.</p>
        </section>

        <aside class="panel stats-panel" aria-labelledby="stats-heading">
          <h2 id="stats-heading">Live Session Stats</h2>
          <dl class="stats-grid">
            <div>
              <dt>App state</dt>
              <dd id="tracking-state-value">Idle</dd>
            </div>
            <div>
              <dt>Tracking quality</dt>
              <dd id="tracking-quality-value">no_face</dd>
            </div>
            <div>
              <dt>Face</dt>
              <dd id="face-status">No face</dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd id="session-timer">00:00.000</dd>
            </div>
            <div>
              <dt>Total blinks</dt>
              <dd id="blink-count">0</dd>
            </div>
            <div>
              <dt>Blinks / min</dt>
              <dd id="blink-rate">0.00</dd>
            </div>
            <div>
              <dt>Last blink</dt>
              <dd id="last-blink-time">--</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd id="tracking-reason">Awaiting session</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section class="layout lower-layout">
        <section class="panel" aria-labelledby="settings-heading">
          <div class="panel-header">
            <h2 id="settings-heading">Detector Settings</h2>
            <p class="muted">Saved locally and applied to future sessions.</p>
          </div>
          <form id="settings-form" class="settings-grid">
            ${createSettingsMarkup()}
          </form>
          <div class="controls compact-controls">
            <button id="apply-settings-button" type="button">Apply</button>
            <button id="reset-settings-button" type="button" class="button-secondary">Reset To Defaults</button>
          </div>
        </section>

        <section class="panel" aria-labelledby="debug-heading">
          <div class="panel-header">
            <h2 id="debug-heading">Live Debug Metrics</h2>
            <p class="muted">Raw and smoothed detector values.</p>
          </div>
          <dl class="debug-grid">
            <div><dt>left EAR</dt><dd id="debug-left-ear">0.000</dd></div>
            <div><dt>right EAR</dt><dd id="debug-right-ear">0.000</dd></div>
            <div><dt>combined EAR</dt><dd id="debug-combined-ear">0.000</dd></div>
            <div><dt>smoothed EAR</dt><dd id="debug-smoothed-ear">0.000</dd></div>
            <div><dt>pitch</dt><dd id="debug-pitch-deg">0.0</dd></div>
            <div><dt>yaw</dt><dd id="debug-yaw-deg">0.0</dd></div>
            <div><dt>roll</dt><dd id="debug-roll-deg">0.0</dd></div>
            <div><dt>pose bucket</dt><dd id="debug-pose-bucket">forward</dd></div>
            <div><dt>ms since pose switch</dt><dd id="debug-pose-switch-ms">0</dd></div>
            <div><dt>pose guard active</dt><dd id="debug-pose-guard">false</dd></div>
            <div><dt>gaze-shift veto</dt><dd id="debug-gaze-veto">false</dd></div>
            <div><dt>blink entry blocked</dt><dd id="debug-blink-entry-blocked">false</dd></div>
            <div><dt>EAR difference</dt><dd id="debug-ear-difference">0.000</dd></div>
            <div><dt>baseline EAR</dt><dd id="debug-baseline-ear">0.000</dd></div>
            <div><dt>forward baseline</dt><dd id="debug-baseline-forward">0.000</dd></div>
            <div><dt>downward baseline</dt><dd id="debug-baseline-downward">0.000</dd></div>
            <div><dt>active baseline</dt><dd id="debug-active-baseline">0.000</dd></div>
            <div><dt>detector state</dt><dd id="debug-detector-state">idle</dd></div>
            <div><dt>tracking quality</dt><dd id="debug-quality-state">no_face</dd></div>
            <div><dt>asymmetry rejection</dt><dd id="debug-asymmetry-rejection">false</dd></div>
            <div><dt>blink asymmetry tolerance</dt><dd id="debug-asymmetry-tolerance">false</dd></div>
            <div><dt>elapsed ms</dt><dd id="debug-elapsed-ms">0</dd></div>
            <div><dt>total blink count</dt><dd id="debug-total-blinks">0</dd></div>
            <div><dt>overall blinks / min</dt><dd id="debug-blink-rate">0.00</dd></div>
            <div><dt>last blink timestamp</dt><dd id="debug-last-blink">--</dd></div>
          </dl>
        </section>
      </section>

      <section class="layout lower-layout">
        <section class="panel" aria-labelledby="last-saved-heading">
          <div class="panel-header">
            <h2 id="last-saved-heading">Last Saved Session</h2>
            <button id="export-last-saved-button" type="button">Export Latest Session CSV</button>
          </div>
          <div id="last-saved-card" class="summary-card empty-card">
            <p class="muted">No saved session yet.</p>
          </div>
        </section>

        <section class="panel" aria-labelledby="exports-heading">
          <div class="panel-header">
            <h2 id="exports-heading">Exports And Storage</h2>
            <button id="clear-recorded-data-button" type="button" class="button-danger">Clear Recorded Data</button>
          </div>
          <div class="export-grid">
            <button id="export-all-blink-events-button" type="button">Export All Blink Events CSV</button>
            <button id="export-all-summaries-button" type="button">Export All Session Summaries CSV</button>
            <button id="export-all-minute-bins-button" type="button">Export All Minute Bins CSV</button>
          </div>
          <p class="muted">Clearing recorded data removes sessions, blink events, and minute bins. Detector settings stay in IndexedDB.</p>
        </section>
      </section>

      <section class="panel sessions-panel" aria-labelledby="sessions-heading">
        <div class="panel-header">
          <h2 id="sessions-heading">Session History</h2>
          <p class="muted">Restored from IndexedDB on reload.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Participant</th>
                <th>Start</th>
                <th>End</th>
                <th>Duration</th>
                <th>Total blinks</th>
                <th>Blinks / min</th>
                <th>Mean intensity</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="sessions-table-body">
              <tr>
                <td colspan="8" class="empty-state">No saved sessions yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;

  const video = root.querySelector<HTMLVideoElement>('#webcam');
  const cameraMessage = root.querySelector<HTMLParagraphElement>('#camera-message');
  const trackingStatus = root.querySelector<HTMLSpanElement>('#tracking-status');
  const qualityStatus = root.querySelector<HTMLSpanElement>('#quality-status');
  const trackingStateValue = root.querySelector<HTMLElement>('#tracking-state-value');
  const trackingQualityValue = root.querySelector<HTMLElement>('#tracking-quality-value');
  const faceStatusValue = root.querySelector<HTMLElement>('#face-status');
  const timerValue = root.querySelector<HTMLElement>('#session-timer');
  const blinkCountValue = root.querySelector<HTMLElement>('#blink-count');
  const blinkRateValue = root.querySelector<HTMLElement>('#blink-rate');
  const lastBlinkTimeValue = root.querySelector<HTMLElement>('#last-blink-time');
  const trackingReasonValue = root.querySelector<HTMLElement>('#tracking-reason');
  const participantLabelInput = root.querySelector<HTMLInputElement>('#participant-label-input');
  const sessionNotesInput = root.querySelector<HTMLTextAreaElement>('#session-notes-input');
  const startButton = root.querySelector<HTMLButtonElement>('#start-button');
  const stopButton = root.querySelector<HTMLButtonElement>('#stop-button');
  const exportCurrentButton = root.querySelector<HTMLButtonElement>('#export-current-button');
  const startStatusMessage = root.querySelector<HTMLParagraphElement>('#start-status-message');
  const settingsForm = root.querySelector<HTMLFormElement>('#settings-form');
  const applySettingsButton = root.querySelector<HTMLButtonElement>('#apply-settings-button');
  const resetSettingsButton = root.querySelector<HTMLButtonElement>('#reset-settings-button');
  const debugLeftEar = root.querySelector<HTMLElement>('#debug-left-ear');
  const debugRightEar = root.querySelector<HTMLElement>('#debug-right-ear');
  const debugCombinedEar = root.querySelector<HTMLElement>('#debug-combined-ear');
  const debugSmoothedEar = root.querySelector<HTMLElement>('#debug-smoothed-ear');
  const debugPitchDeg = root.querySelector<HTMLElement>('#debug-pitch-deg');
  const debugYawDeg = root.querySelector<HTMLElement>('#debug-yaw-deg');
  const debugRollDeg = root.querySelector<HTMLElement>('#debug-roll-deg');
  const debugPoseBucket = root.querySelector<HTMLElement>('#debug-pose-bucket');
  const debugPoseSwitchMs = root.querySelector<HTMLElement>('#debug-pose-switch-ms');
  const debugPoseGuard = root.querySelector<HTMLElement>('#debug-pose-guard');
  const debugGazeVeto = root.querySelector<HTMLElement>('#debug-gaze-veto');
  const debugBlinkEntryBlocked = root.querySelector<HTMLElement>('#debug-blink-entry-blocked');
  const debugEarDifference = root.querySelector<HTMLElement>('#debug-ear-difference');
  const debugBaselineEar = root.querySelector<HTMLElement>('#debug-baseline-ear');
  const debugBaselineForward = root.querySelector<HTMLElement>('#debug-baseline-forward');
  const debugBaselineDownward = root.querySelector<HTMLElement>('#debug-baseline-downward');
  const debugActiveBaseline = root.querySelector<HTMLElement>('#debug-active-baseline');
  const debugDetectorState = root.querySelector<HTMLElement>('#debug-detector-state');
  const debugQualityState = root.querySelector<HTMLElement>('#debug-quality-state');
  const debugAsymmetryRejection = root.querySelector<HTMLElement>('#debug-asymmetry-rejection');
  const debugAsymmetryTolerance = root.querySelector<HTMLElement>('#debug-asymmetry-tolerance');
  const debugElapsedMs = root.querySelector<HTMLElement>('#debug-elapsed-ms');
  const debugTotalBlinks = root.querySelector<HTMLElement>('#debug-total-blinks');
  const debugBlinkRate = root.querySelector<HTMLElement>('#debug-blink-rate');
  const debugLastBlink = root.querySelector<HTMLElement>('#debug-last-blink');
  const exportLastSavedButton = root.querySelector<HTMLButtonElement>('#export-last-saved-button');
  const exportAllBlinkEventsButton = root.querySelector<HTMLButtonElement>('#export-all-blink-events-button');
  const exportAllSummariesButton = root.querySelector<HTMLButtonElement>('#export-all-summaries-button');
  const exportAllMinuteBinsButton = root.querySelector<HTMLButtonElement>('#export-all-minute-bins-button');
  const clearRecordedDataButton = root.querySelector<HTMLButtonElement>('#clear-recorded-data-button');
  const lastSavedCard = root.querySelector<HTMLDivElement>('#last-saved-card');
  const sessionsTableBody = root.querySelector<HTMLTableSectionElement>('#sessions-table-body');

  if (
    !video ||
    !cameraMessage ||
    !trackingStatus ||
    !qualityStatus ||
    !trackingStateValue ||
    !trackingQualityValue ||
    !faceStatusValue ||
    !timerValue ||
    !blinkCountValue ||
    !blinkRateValue ||
    !lastBlinkTimeValue ||
    !trackingReasonValue ||
    !participantLabelInput ||
    !sessionNotesInput ||
    !startButton ||
    !stopButton ||
    !exportCurrentButton ||
    !startStatusMessage ||
    !settingsForm ||
    !applySettingsButton ||
    !resetSettingsButton ||
    !debugLeftEar ||
    !debugRightEar ||
    !debugCombinedEar ||
    !debugSmoothedEar ||
    !debugPitchDeg ||
    !debugYawDeg ||
    !debugRollDeg ||
    !debugPoseBucket ||
    !debugPoseSwitchMs ||
    !debugPoseGuard ||
    !debugGazeVeto ||
    !debugBlinkEntryBlocked ||
    !debugEarDifference ||
    !debugBaselineEar ||
    !debugBaselineForward ||
    !debugBaselineDownward ||
    !debugActiveBaseline ||
    !debugDetectorState ||
    !debugQualityState ||
    !debugAsymmetryRejection ||
    !debugAsymmetryTolerance ||
    !debugElapsedMs ||
    !debugTotalBlinks ||
    !debugBlinkRate ||
    !debugLastBlink ||
    !exportLastSavedButton ||
    !exportAllBlinkEventsButton ||
    !exportAllSummariesButton ||
    !exportAllMinuteBinsButton ||
    !clearRecordedDataButton ||
    !lastSavedCard ||
    !sessionsTableBody
  ) {
    throw new Error('App UI failed to initialize.');
  }

  const camera = new CameraController();
  let trackingState: TrackingState = 'idle';
  let trackingQualityState: TrackingQualityState = 'no_face';
  let activeSession: ActiveSession | null = null;
  let savedSessions: SessionSummary[] = [];
  let faceLandmarker: FaceLandmarker | null = null;
  let detector: BlinkDetector | null = null;
  let isLandmarkerLoading = false;
  let animationFrameId = 0;
  let frameIndex = 0;
  let lastSavedSnapshot: SessionSnapshot | null = null;
  let currentSettings: DetectorSettings = { ...DEFAULT_DETECTOR_SETTINGS };
  let liveDebugMetrics = createEmptyDebugMetrics();

  const formatElapsedClock = (durationMs: number): string => {
    const totalMilliseconds = Math.max(0, Math.floor(durationMs));
    const totalSeconds = Math.floor(totalMilliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    const milliseconds = (totalMilliseconds % 1000).toString().padStart(3, '0');
    return `${minutes}:${seconds}.${milliseconds}`;
  };

  const formatMilliseconds = (value: number | null): string => (value === null ? '--' : `${Math.round(value)}`);

  const formatOptionalMilliseconds = (value: number | null): string => {
    return value === null ? '--' : `${Math.round(value)} ms`;
  };

  const formatDateTime = (isoTimestamp: string): string => {
    if (!isoTimestamp) {
      return '--';
    }

    return new Date(isoTimestamp).toLocaleString();
  };

  const formatQualityLabel = (value: TrackingQualityState): string => value.replaceAll('_', ' ');

  const renderSettingsForm = (settings: DetectorSettings) => {
    for (const field of SETTING_FIELDS) {
      const input = settingsForm.querySelector<HTMLInputElement>(`[data-setting-key="${field.key}"]`);

      if (input) {
        input.value = String(settings[field.key]);
      }
    }
  };

  const readSettingsForm = (): DetectorSettings | null => {
    const nextSettings = { ...currentSettings };

    for (const field of SETTING_FIELDS) {
      const input = settingsForm.querySelector<HTMLInputElement>(`[data-setting-key="${field.key}"]`);

      if (!input) {
        return null;
      }

      const parsedValue = Number(input.value);

      if (!Number.isFinite(parsedValue)) {
        cameraMessage.textContent = `Invalid value for ${field.label}.`;
        return null;
      }

      nextSettings[field.key] = parsedValue;
    }

    return sanitizeDetectorSettings(nextSettings);
  };

  const updateTrackingState = (nextState: TrackingState, message?: string) => {
    trackingState = nextState;
    const label = nextState.replaceAll('_', ' ').replaceAll('-', ' ');
    trackingStatus.textContent = label;
    trackingStatus.dataset.state = nextState;
    trackingStateValue.textContent = label;

    if (message) {
      cameraMessage.textContent = message;
    }
  };

  const updateTrackingQuality = (nextQualityState: TrackingQualityState, reason: string) => {
    trackingQualityState = nextQualityState;
    const label = formatQualityLabel(nextQualityState);
    qualityStatus.textContent = label;
    qualityStatus.dataset.quality = nextQualityState;
    trackingQualityValue.textContent = label;
    debugQualityState.textContent = label;
    trackingReasonValue.textContent = reason;
  };

  const resetLiveState = () => {
    liveDebugMetrics = createEmptyDebugMetrics();
    trackingQualityState = 'no_face';
  };

  const getElapsedMs = (): number => (activeSession ? Date.now() - activeSession.startedAtMs : 0);

  const getCurrentBlinksPerMinute = (): number => {
    const durationMs = getElapsedMs();

    if (!activeSession || durationMs <= 0) {
      return 0;
    }

    return (activeSession.blinkEvents.length / durationMs) * 60_000;
  };

  const renderDebugMetrics = () => {
    debugLeftEar.textContent = liveDebugMetrics.leftEar.toFixed(3);
    debugRightEar.textContent = liveDebugMetrics.rightEar.toFixed(3);
    debugCombinedEar.textContent = liveDebugMetrics.combinedEar.toFixed(3);
    debugSmoothedEar.textContent = liveDebugMetrics.smoothedEar.toFixed(3);
    debugPitchDeg.textContent = liveDebugMetrics.pitchDeg.toFixed(1);
    debugYawDeg.textContent = liveDebugMetrics.yawDeg.toFixed(1);
    debugRollDeg.textContent = liveDebugMetrics.rollDeg.toFixed(1);
    debugPoseBucket.textContent = liveDebugMetrics.poseBucket;
    debugPoseSwitchMs.textContent = `${Math.round(liveDebugMetrics.timeSinceLastPoseBucketSwitchMs)}`;
    debugPoseGuard.textContent = String(liveDebugMetrics.poseTransitionGuardActive);
    debugGazeVeto.textContent = String(liveDebugMetrics.gazeShiftVetoActive);
    debugBlinkEntryBlocked.textContent = String(liveDebugMetrics.blinkEntryBlockedByPoseStabilization);
    debugEarDifference.textContent = liveDebugMetrics.earDifference.toFixed(3);
    debugBaselineEar.textContent = liveDebugMetrics.baselineEar.toFixed(3);
    debugBaselineForward.textContent = liveDebugMetrics.baselineForwardEar.toFixed(3);
    debugBaselineDownward.textContent = liveDebugMetrics.baselineDownwardEar.toFixed(3);
    debugActiveBaseline.textContent = liveDebugMetrics.activeBaselineEar.toFixed(3);
    debugDetectorState.textContent = liveDebugMetrics.detectorState;
    debugQualityState.textContent = formatQualityLabel(liveDebugMetrics.trackingQualityState);
    debugAsymmetryRejection.textContent = String(liveDebugMetrics.asymmetryRejectionActive);
    debugAsymmetryTolerance.textContent = String(liveDebugMetrics.blinkPhaseAsymmetryToleranceActive);
    debugElapsedMs.textContent = `${Math.round(liveDebugMetrics.elapsedSessionMs)}`;
    debugTotalBlinks.textContent = `${liveDebugMetrics.totalBlinkCount}`;
    debugBlinkRate.textContent = liveDebugMetrics.overallBlinksPerMinute.toFixed(2);
    debugLastBlink.textContent = liveDebugMetrics.lastBlinkTimestampMs === null ? '--' : `${Math.round(liveDebugMetrics.lastBlinkTimestampMs)} ms`;
  };

  const renderActionState = () => {
    const hasSavedSessions = savedSessions.length > 0;
    const startDisabledReason =
      activeSession !== null
        ? 'Start disabled: session already active.'
        : !camera.isActive
          ? 'Start disabled: camera not ready.'
          : isLandmarkerLoading
            ? 'Start disabled: MediaPipe still loading.'
            : null;

    startButton.disabled = startDisabledReason !== null;
    stopButton.disabled = activeSession === null;
    exportCurrentButton.disabled = activeSession === null && !hasSavedSessions;
    exportLastSavedButton.disabled = !hasSavedSessions;
    exportAllBlinkEventsButton.disabled = !hasSavedSessions;
    exportAllSummariesButton.disabled = !hasSavedSessions;
    exportAllMinuteBinsButton.disabled = !hasSavedSessions;
    clearRecordedDataButton.disabled = activeSession !== null || !hasSavedSessions;

    if (startDisabledReason !== null) {
      startStatusMessage.textContent = startDisabledReason;
    } else if (!activeSession && trackingQualityState === 'no_face') {
      startStatusMessage.textContent = 'You can start the session; tracking will begin when a face is visible.';
    } else if (!activeSession) {
      startStatusMessage.textContent = 'Ready to start a session.';
    } else {
      startStatusMessage.textContent = 'Session running.';
    }
  };

  const renderStats = () => {
    const durationMs = getElapsedMs();
    const totalBlinks = activeSession?.blinkEvents.length ?? 0;
    const blinkRate = getCurrentBlinksPerMinute();

    timerValue.textContent = formatElapsedClock(durationMs);
    blinkCountValue.textContent = String(totalBlinks);
    blinkRateValue.textContent = blinkRate.toFixed(2);
    lastBlinkTimeValue.textContent =
      liveDebugMetrics.lastBlinkTimestampMs === null ? '--' : `${Math.round(liveDebugMetrics.lastBlinkTimestampMs)} ms`;

    liveDebugMetrics.elapsedSessionMs = durationMs;
    liveDebugMetrics.totalBlinkCount = totalBlinks;
    liveDebugMetrics.overallBlinksPerMinute = blinkRate;

    renderDebugMetrics();
    renderActionState();
  };

  const renderLastSavedSession = (summary: SessionSummary | null) => {
    if (!summary) {
      lastSavedCard.className = 'summary-card empty-card';
      lastSavedCard.innerHTML = '<p class="muted">No saved session yet.</p>';
      return;
    }

    lastSavedCard.className = 'summary-card';
    lastSavedCard.innerHTML = `
      <dl class="summary-grid">
        <div><dt>Participant</dt><dd>${summary.participantLabel || '--'}</dd></div>
        <div><dt>Notes</dt><dd>${summary.sessionNotes || '--'}</dd></div>
        <div><dt>Start</dt><dd>${formatDateTime(summary.startedAtIso)}</dd></div>
        <div><dt>End</dt><dd>${formatDateTime(summary.endedAtIso)}</dd></div>
        <div><dt>Duration</dt><dd>${formatElapsedClock(summary.durationMs)}</dd></div>
        <div><dt>Total blinks</dt><dd>${summary.totalBlinks}</dd></div>
        <div><dt>Blinks / min</dt><dd>${summary.overallBlinksPerMinute.toFixed(2)}</dd></div>
        <div><dt>Mean intensity</dt><dd>${summary.meanIntensity.toFixed(3)}</dd></div>
        <div><dt>Mean IBI</dt><dd>${formatOptionalMilliseconds(summary.meanInterBlinkIntervalMs)}</dd></div>
        <div><dt>Last export</dt><dd>${summary.exportedAtIso ? formatDateTime(summary.exportedAtIso) : '--'}</dd></div>
      </dl>
    `;
  };

  const renderSessions = (sessions: SessionSummary[]) => {
    if (sessions.length === 0) {
      sessionsTableBody.innerHTML = `
        <tr>
          <td colspan="8" class="empty-state">No saved sessions yet.</td>
        </tr>
      `;
      return;
    }

    sessionsTableBody.innerHTML = sessions
      .map(
        (session) => `
          <tr>
            <td>${session.participantLabel || '--'}</td>
            <td>${formatDateTime(session.startedAtIso)}</td>
            <td>${formatDateTime(session.endedAtIso)}</td>
            <td>${formatElapsedClock(session.durationMs)}</td>
            <td>${session.totalBlinks}</td>
            <td>${session.overallBlinksPerMinute.toFixed(2)}</td>
            <td>${session.meanIntensity.toFixed(3)}</td>
            <td><button class="button-secondary table-action" type="button" data-session-id="${session.id}">Export CSV</button></td>
          </tr>
        `
      )
      .join('');
  };

  const buildMinuteBins = (session: ActiveSession, endedAtMs: number): MinuteBin[] => {
    const durationMs = Math.max(0, endedAtMs - session.startedAtMs);
    const minuteCount = Math.max(1, Math.ceil(durationMs / 60_000));
    const bins: MinuteBin[] = [];

    for (let minuteIndex = 0; minuteIndex < minuteCount; minuteIndex += 1) {
      const minuteStartMs = minuteIndex * 60_000;
      const minuteEndMs = Math.min(durationMs, minuteStartMs + 60_000);
      const blinkCount = session.blinkEvents.filter(
        (event) => event.timeFromSessionStartMs >= minuteStartMs && event.timeFromSessionStartMs < minuteEndMs
      ).length;
      const spanMs = Math.max(0, minuteEndMs - minuteStartMs);

      bins.push({
        id: `${session.id}:${minuteIndex}`,
        sessionId: session.id,
        minuteIndex,
        minuteStartMs,
        minuteEndMs,
        blinkCount,
        blinksPerMinuteEquivalent: spanMs > 0 ? (blinkCount / spanMs) * 60_000 : 0
      });
    }

    return bins;
  };

  const buildSessionSummary = (session: ActiveSession, endedAtMs: number): SessionSummary => {
    const durationMs = Math.max(0, endedAtMs - session.startedAtMs);
    const totalBlinks = session.blinkEvents.length;
    const overallBlinksPerMinute = durationMs > 0 ? (totalBlinks / durationMs) * 60_000 : 0;
    const intervals = session.blinkEvents
      .map((event) => event.interBlinkIntervalMs)
      .filter((value): value is number => value !== null);
    const intensities = session.blinkEvents.map((event) => event.intensity);

    return {
      id: session.id,
      participantLabel: session.participantLabel,
      sessionNotes: session.sessionNotes,
      startedAtIso: session.startedAtIso,
      endedAtIso: new Date(endedAtMs).toISOString(),
      durationMs,
      totalBlinks,
      overallBlinksPerMinute,
      meanInterBlinkIntervalMs:
        intervals.length > 0 ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : null,
      meanIntensity: intensities.length > 0 ? intensities.reduce((sum, value) => sum + value, 0) / intensities.length : 0,
      maxIntensity: intensities.length > 0 ? Math.max(...intensities) : 0,
      exportedAtIso: null
    };
  };

  const createSessionSnapshot = (session: ActiveSession, endedAtMs: number): SessionSnapshot => ({
    summary: buildSessionSummary(session, endedAtMs),
    blinkEvents: session.blinkEvents.map((event) => ({ ...event })),
    minuteBins: buildMinuteBins(session, endedAtMs)
  });

  const refreshSessions = async () => {
    savedSessions = await listSessions();
    renderSessions(savedSessions);
    renderLastSavedSession(savedSessions[0] ?? null);

    if (savedSessions.length === 0) {
      lastSavedSnapshot = null;
    } else if (lastSavedSnapshot && lastSavedSnapshot.summary.id === savedSessions[0].id) {
      lastSavedSnapshot = {
        ...lastSavedSnapshot,
        summary: savedSessions[0]
      };
    }

    renderActionState();
  };

  const loadLatestSavedSnapshot = async (): Promise<SessionSnapshot | null> => {
    const latestSummary = savedSessions[0];

    if (!latestSummary) {
      return null;
    }

    if (lastSavedSnapshot && lastSavedSnapshot.summary.id === latestSummary.id) {
      return {
        ...lastSavedSnapshot,
        summary: latestSummary
      };
    }

    const snapshot = await getSessionSnapshot(latestSummary.id);

    if (snapshot) {
      lastSavedSnapshot = snapshot;
    }

    return snapshot;
  };

  const exportSavedSnapshot = async (snapshot: SessionSnapshot): Promise<void> => {
    const exportedAtIso = new Date().toISOString();
    const exportedSnapshot: SessionSnapshot = {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        exportedAtIso
      }
    };

    exportCurrentSessionBlinkEventsCsv(exportedSnapshot);
    await markSessionsExported([snapshot.summary.id], exportedAtIso);
    lastSavedSnapshot = exportedSnapshot;
    await refreshSessions();
  };

  const syncQualityUi = (quality: TrackingQualityState, reason: string, faceLabel: string, appState?: TrackingState) => {
    if (appState) {
      updateTrackingState(appState, reason);
    } else {
      cameraMessage.textContent = reason;
    }

    updateTrackingQuality(quality, reason);
    faceStatusValue.textContent = faceLabel;
  };

  const processFrame = () => {
    if (!activeSession || !faceLandmarker || !detector) {
      return;
    }

    frameIndex += 1;
    const sessionElapsedMs = Date.now() - activeSession.startedAtMs;
    const result = faceLandmarker.detectForVideo(video, performance.now());
    const landmarks = result.faceLandmarks[0];

    if (!landmarks) {
      const detection = detector.update({
        leftEar: 0,
        rightEar: 0,
        combinedEar: 0,
        pitchDeg: liveDebugMetrics.pitchDeg,
        yawDeg: liveDebugMetrics.yawDeg,
        rollDeg: liveDebugMetrics.rollDeg,
        gazeDownwardScore: null,
        hasGazeEstimate: false,
        frameIndex,
        faceTracked: false,
        sessionElapsedMs
      });

      liveDebugMetrics.leftEar = 0;
      liveDebugMetrics.rightEar = 0;
      liveDebugMetrics.combinedEar = 0;
      liveDebugMetrics.smoothedEar = detection.smoothedCombinedEar;
      liveDebugMetrics.pitchDeg = detection.pitchDeg;
      liveDebugMetrics.yawDeg = detection.yawDeg;
      liveDebugMetrics.rollDeg = detection.rollDeg;
      liveDebugMetrics.poseBucket = detection.poseBucket;
      liveDebugMetrics.timeSinceLastPoseBucketSwitchMs = detection.timeSinceLastPoseBucketSwitchMs;
      liveDebugMetrics.poseTransitionGuardActive = detection.poseTransitionGuardActive;
      liveDebugMetrics.gazeShiftVetoActive = detection.gazeShiftVetoActive;
      liveDebugMetrics.blinkEntryBlockedByPoseStabilization = detection.blinkEntryBlockedByPoseStabilization;
      liveDebugMetrics.earDifference = detection.asymmetryDifference;
      liveDebugMetrics.baselineEar = detection.baselineEar ?? liveDebugMetrics.baselineEar;
      liveDebugMetrics.baselineForwardEar = detection.baselineForwardEar ?? liveDebugMetrics.baselineForwardEar;
      liveDebugMetrics.baselineDownwardEar = detection.baselineDownwardEar ?? liveDebugMetrics.baselineDownwardEar;
      liveDebugMetrics.activeBaselineEar = detection.activeBaselineEar ?? liveDebugMetrics.activeBaselineEar;
      liveDebugMetrics.detectorState = detection.phase;
      liveDebugMetrics.trackingQualityState = detection.trackingQualityState;
      liveDebugMetrics.asymmetryRejectionActive = detection.asymmetryRejectionActive;
      liveDebugMetrics.blinkPhaseAsymmetryToleranceActive = detection.blinkPhaseAsymmetryToleranceActive;
      syncQualityUi('no_face', 'No face detected. Blink counting is paused.', 'No face', detection.trackingQualityState === 'warming_up' ? 'warming_up' : 'tracking');
      renderStats();
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    const { leftEar, rightEar, combinedEar } = computeEarReadings(landmarks);
    const { pitchDeg, yawDeg, rollDeg } = estimateHeadPose(landmarks);
    const gazeEstimate = estimateEyeGaze(landmarks);
    const detection = detector.update({
      leftEar,
      rightEar,
      combinedEar,
      pitchDeg,
      yawDeg,
      rollDeg,
      gazeDownwardScore: gazeEstimate.downwardScore,
      hasGazeEstimate: gazeEstimate.hasIrisData,
      frameIndex,
      faceTracked: true,
      sessionElapsedMs
    });

    liveDebugMetrics.leftEar = leftEar;
    liveDebugMetrics.rightEar = rightEar;
    liveDebugMetrics.combinedEar = combinedEar;
    liveDebugMetrics.smoothedEar = detection.smoothedCombinedEar;
    liveDebugMetrics.pitchDeg = detection.pitchDeg;
    liveDebugMetrics.yawDeg = detection.yawDeg;
    liveDebugMetrics.rollDeg = detection.rollDeg;
    liveDebugMetrics.poseBucket = detection.poseBucket;
    liveDebugMetrics.timeSinceLastPoseBucketSwitchMs = detection.timeSinceLastPoseBucketSwitchMs;
    liveDebugMetrics.poseTransitionGuardActive = detection.poseTransitionGuardActive;
    liveDebugMetrics.gazeShiftVetoActive = detection.gazeShiftVetoActive;
    liveDebugMetrics.blinkEntryBlockedByPoseStabilization = detection.blinkEntryBlockedByPoseStabilization;
    liveDebugMetrics.earDifference = detection.asymmetryDifference;
    liveDebugMetrics.baselineEar = detection.baselineEar ?? 0;
    liveDebugMetrics.baselineForwardEar = detection.baselineForwardEar ?? 0;
    liveDebugMetrics.baselineDownwardEar = detection.baselineDownwardEar ?? 0;
    liveDebugMetrics.activeBaselineEar = detection.activeBaselineEar ?? 0;
    liveDebugMetrics.detectorState = detection.phase;
    liveDebugMetrics.trackingQualityState = detection.trackingQualityState;
    liveDebugMetrics.asymmetryRejectionActive = detection.asymmetryRejectionActive;
    liveDebugMetrics.blinkPhaseAsymmetryToleranceActive = detection.blinkPhaseAsymmetryToleranceActive;

    if (detection.blink) {
      const event: BlinkEvent = {
        id: crypto.randomUUID(),
        sessionId: activeSession.id,
        blinkIndex: detection.blink.blinkIndex,
        startMs: detection.blink.startMs,
        peakMs: detection.blink.peakMs,
        endMs: detection.blink.endMs,
        durationMs: detection.blink.durationMs,
        timeFromSessionStartMs: detection.blink.timeFromSessionStartMs,
        wallClockIso: new Date(activeSession.startedAtMs + detection.blink.peakMs).toISOString(),
        leftEarMin: detection.blink.leftEarMin,
        rightEarMin: detection.blink.rightEarMin,
        combinedEarMin: detection.blink.combinedEarMin,
        baselineEar: detection.blink.baselineEar,
        intensity: detection.blink.intensity,
        interBlinkIntervalMs: detection.blink.interBlinkIntervalMs
      };

      activeSession.blinkEvents.push(event);
      liveDebugMetrics.lastBlinkTimestampMs = event.timeFromSessionStartMs;
    }

    switch (detection.trackingQualityState) {
      case 'warming_up':
        syncQualityUi('warming_up', 'Warming up to establish open-eye baseline EAR.', 'Stable face', 'warming_up');
        break;
      case 'stabilizing':
        syncQualityUi(
          'stabilizing',
          detection.gazeShiftVetoActive
            ? 'Downward gaze shift detected. Blink entry is temporarily vetoed.'
            : detection.poseTransitionGuardActive || detection.blinkEntryBlockedByPoseStabilization
              ? 'Pose changed recently. Blink entry is briefly blocked while the downward pose stabilizes.'
              : 'Tracking recovered, waiting for stable frames before baseline and blink detection resume.',
          'Stable face',
          'tracking'
        );
        break;
      case 'tracking_unstable':
        syncQualityUi(
          'tracking_unstable',
          detection.unstableReason ?? 'Tracking unstable. Blink counting is paused.',
          'Unstable face',
          'tracking'
        );
        break;
      case 'blink_in_progress':
        syncQualityUi('blink_in_progress', 'Blink in progress.', 'Stable face', 'tracking');
        break;
      case 'tracking_stable':
        syncQualityUi('tracking_stable', 'Tracking stable. Blink detection active.', 'Stable face', 'tracking');
        break;
      case 'no_face':
        syncQualityUi('no_face', 'No face detected. Blink counting is paused.', 'No face', 'tracking');
        break;
    }

    renderStats();
    animationFrameId = requestAnimationFrame(processFrame);
  };

  const stopTracking = async () => {
    if (!activeSession) {
      return;
    }

    cancelAnimationFrame(animationFrameId);
    const sessionEndedAtMs = Date.now();
    const snapshot = createSessionSnapshot(activeSession, sessionEndedAtMs);

    await saveSessionSnapshot(snapshot);

    lastSavedSnapshot = snapshot;
    activeSession = null;
    detector = null;
    resetLiveState();
    faceStatusValue.textContent = 'Idle';
    updateTrackingState('stopped', 'Session saved locally.');
    updateTrackingQuality('no_face', 'Session stopped. Start another session when ready.');
    renderStats();
    await refreshSessions();
  };

  const ensureCameraReady = async () => {
    try {
      updateTrackingState('camera-starting', 'Requesting webcam access...');
      await camera.start(video);
      updateTrackingState('camera-ready', 'Webcam ready. You can start the session; tracking will begin when a face is visible.');
      renderStats();
    } catch (error) {
      console.error(error);
      updateTrackingState('error', 'Webcam access failed. Allow camera access in Chrome and reload.');
      renderStats();
    }
  };

  const ensureLandmarker = async () => {
    if (faceLandmarker) {
      return faceLandmarker;
    }

    isLandmarkerLoading = true;
    renderStats();

    try {
      updateTrackingState('loading-model', activeSession ? 'Session started. Loading local MediaPipe model...' : 'Loading local MediaPipe model...');
      faceLandmarker = await loadFaceLandmarker();

      if (!activeSession) {
        updateTrackingState('camera-ready', 'Model loaded locally. You can start the session; tracking will begin when a face is visible.');
      }

      return faceLandmarker;
    } finally {
      isLandmarkerLoading = false;
      renderStats();
    }
  };

  const applyDetectorSettingsToFutureSessions = async (settings: DetectorSettings, message: string) => {
    currentSettings = sanitizeDetectorSettings(settings);
    renderSettingsForm(currentSettings);
    await saveDetectorSettings(currentSettings);
    cameraMessage.textContent = message;
  };

  startButton.addEventListener('click', async () => {
    if (activeSession) {
      return;
    }

    const participantLabel = participantLabelInput.value.trim();
    const sessionNotes = sessionNotesInput.value.trim();

    try {
      if (!camera.isActive) {
        await ensureCameraReady();
      }

      detector = new BlinkDetector(currentSettings);
      resetLiveState();
      frameIndex = 0;

      activeSession = {
        id: crypto.randomUUID(),
        startedAtMs: Date.now(),
        startedAtIso: new Date().toISOString(),
        participantLabel,
        sessionNotes,
        blinkEvents: []
      };

      faceStatusValue.textContent = 'Waiting for face';
      updateTrackingState('warming_up', 'Session started. Tracking will begin when a face is visible. Warm-up will complete only with stable tracking.');
      updateTrackingQuality('warming_up', 'Session running. If no face is visible yet, blink counting remains paused.');
      renderStats();

      await ensureLandmarker();

      if (!activeSession) {
        return;
      }

      animationFrameId = requestAnimationFrame(processFrame);
    } catch (error) {
      console.error(error);
      activeSession = null;
      detector = null;
      isLandmarkerLoading = false;
      updateTrackingState('error', 'Unable to start tracking. Check that local MediaPipe assets are present.');
      renderStats();
    }
  });

  stopButton.addEventListener('click', () => {
    void stopTracking();
  });

  applySettingsButton.addEventListener('click', async () => {
    const nextSettings = readSettingsForm();

    if (!nextSettings) {
      return;
    }

    await applyDetectorSettingsToFutureSessions(
      nextSettings,
      activeSession
        ? 'Detector settings saved locally. They will apply to the next session.'
        : 'Detector settings saved locally.'
    );
  });

  resetSettingsButton.addEventListener('click', async () => {
    const resetSettings = sanitizeDetectorSettings({ ...DEFAULT_DETECTOR_SETTINGS });
    await applyDetectorSettingsToFutureSessions(
      resetSettings,
      activeSession
        ? 'Detector settings reset to defaults. The next session will use them.'
        : 'Detector settings reset to defaults.'
    );
  });

  exportCurrentButton.addEventListener('click', async () => {
    if (activeSession) {
      exportCurrentSessionBlinkEventsCsv(createSessionSnapshot(activeSession, Date.now()));
      return;
    }

    const snapshot = await loadLatestSavedSnapshot();

    if (!snapshot) {
      cameraMessage.textContent = 'No saved session available to export.';
      return;
    }

    await exportSavedSnapshot(snapshot);
  });

  exportLastSavedButton.addEventListener('click', async () => {
    const snapshot = await loadLatestSavedSnapshot();

    if (!snapshot) {
      cameraMessage.textContent = 'No saved session available to export.';
      return;
    }

    await exportSavedSnapshot(snapshot);
  });

  exportAllBlinkEventsButton.addEventListener('click', async () => {
    const [sessions, blinkEvents] = await Promise.all([listSessions(), listAllBlinkEvents()]);
    const exportedAtIso = new Date().toISOString();

    exportAllBlinkEventsCsv(blinkEvents);

    if (sessions.length > 0) {
      await markSessionsExported(
        sessions.map((session) => session.id),
        exportedAtIso
      );
      await refreshSessions();
    }
  });

  exportAllSummariesButton.addEventListener('click', async () => {
    const sessions = await listSessions();
    const exportedAtIso = new Date().toISOString();
    const exportedSessions = sessions.map((session) => ({
      ...session,
      exportedAtIso
    }));

    exportAllSessionSummariesCsv(exportedSessions);

    if (sessions.length > 0) {
      await markSessionsExported(
        sessions.map((session) => session.id),
        exportedAtIso
      );
      await refreshSessions();
    }
  });

  exportAllMinuteBinsButton.addEventListener('click', async () => {
    const [sessions, minuteBins] = await Promise.all([listSessions(), listAllMinuteBins()]);
    const exportedAtIso = new Date().toISOString();

    exportAllMinuteBinsCsv(minuteBins);

    if (sessions.length > 0) {
      await markSessionsExported(
        sessions.map((session) => session.id),
        exportedAtIso
      );
      await refreshSessions();
    }
  });

  clearRecordedDataButton.addEventListener('click', async () => {
    const shouldClear = window.confirm(
      'Clear all recorded sessions, blink events, and minute bins from this browser? Detector settings will be preserved.'
    );

    if (!shouldClear) {
      return;
    }

    await clearRecordedData();
    savedSessions = [];
    lastSavedSnapshot = null;
    cameraMessage.textContent = 'Recorded data cleared locally. Detector settings were preserved.';
    await refreshSessions();
    renderStats();
  });

  sessionsTableBody.addEventListener('click', async (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest<HTMLButtonElement>('button[data-session-id]');

    if (!button) {
      return;
    }

    const sessionId = button.dataset.sessionId;

    if (!sessionId) {
      return;
    }

    const snapshot = await getSessionSnapshot(sessionId);

    if (!snapshot) {
      cameraMessage.textContent = 'The selected session could not be loaded.';
      return;
    }

    await exportSavedSnapshot(snapshot);
  });

  window.addEventListener('beforeunload', () => {
    cancelAnimationFrame(animationFrameId);
    camera.stop(video);
  });

  await initStorage();
  currentSettings = sanitizeDetectorSettings(await loadDetectorSettings());
  renderSettingsForm(currentSettings);
  await refreshSessions();
  resetLiveState();
  renderStats();
  updateTrackingQuality('no_face', 'Awaiting session start.');
  await ensureCameraReady();
}
