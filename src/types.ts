export type TrackingState =
  | 'idle'
  | 'camera-starting'
  | 'camera-ready'
  | 'loading-model'
  | 'warming_up'
  | 'tracking'
  | 'stopped'
  | 'error';

export type TrackingQualityState =
  | 'no_face'
  | 'warming_up'
  | 'stabilizing'
  | 'tracking_stable'
  | 'blink_in_progress'
  | 'tracking_unstable';

export type PoseBucket = 'forward' | 'downward';

export interface DetectorSettings {
  closeRatio: number;
  reopenRatio: number;
  minimumBlinkDurationMs: number;
  maximumBlinkDurationMs: number;
  minimumInterBlinkGapMs: number;
  smoothingWindowSize: number;
  baselineWindowSize: number;
  baselineSmoothingAlpha: number;
  baselineUpdateMinRatio: number;
  recoveryDeltaRatio: number;
  warmupDurationMs: number;
  plausibleEarMin: number;
  plausibleEarMax: number;
  maxLeftRightDifference: number;
  maxLeftRightDifferenceDownward: number;
  maxLeftRightDifferenceDuringBlink: number;
  downwardPitchThresholdDeg: number;
  maxYawForStableDeg: number;
  maxRollForStableDeg: number;
  poseTransitionGuardMs: number;
}

export interface BlinkEvent {
  id: string;
  sessionId: string;
  blinkIndex: number;
  startMs: number;
  peakMs: number;
  endMs: number;
  durationMs: number;
  timeFromSessionStartMs: number;
  wallClockIso: string;
  leftEarMin: number;
  rightEarMin: number;
  combinedEarMin: number;
  baselineEar: number;
  intensity: number;
  interBlinkIntervalMs: number | null;
}

export interface MinuteBin {
  id: string;
  sessionId: string;
  minuteIndex: number;
  minuteStartMs: number;
  minuteEndMs: number;
  blinkCount: number;
  blinksPerMinuteEquivalent: number;
}

export interface SessionSummary {
  id: string;
  participantLabel: string;
  sessionNotes: string;
  startedAtIso: string;
  endedAtIso: string;
  durationMs: number;
  totalBlinks: number;
  overallBlinksPerMinute: number;
  meanInterBlinkIntervalMs: number | null;
  meanIntensity: number;
  maxIntensity: number;
  exportedAtIso: string | null;
}

export interface SessionSnapshot {
  summary: SessionSummary;
  blinkEvents: BlinkEvent[];
  minuteBins: MinuteBin[];
}

export interface LiveDebugMetrics {
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
  poseBucket: PoseBucket;
  timeSinceLastPoseBucketSwitchMs: number;
  poseTransitionGuardActive: boolean;
  gazeShiftVetoActive: boolean;
  blinkEntryBlockedByPoseStabilization: boolean;
  leftEar: number;
  rightEar: number;
  combinedEar: number;
  smoothedEar: number;
  earDifference: number;
  baselineEar: number;
  baselineForwardEar: number;
  baselineDownwardEar: number;
  activeBaselineEar: number;
  detectorState: string;
  trackingQualityState: TrackingQualityState;
  asymmetryRejectionActive: boolean;
  blinkPhaseAsymmetryToleranceActive: boolean;
  elapsedSessionMs: number;
  totalBlinkCount: number;
  overallBlinksPerMinute: number;
  lastBlinkTimestampMs: number | null;
}

export interface SettingsEntry {
  key: string;
  value: unknown;
}
