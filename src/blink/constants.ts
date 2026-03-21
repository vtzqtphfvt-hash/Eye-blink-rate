import type { DetectorSettings } from '../types';

export const LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144] as const;
export const RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380] as const;

export const DETECTOR_SETTINGS_KEY = 'detector_settings';
export const DETECTOR_STABLE_RECOVERY_FRAMES = 4;
export const DETECTOR_BLINK_PHASE_UNSTABLE_TOLERANCE_FRAMES = 3;
export const DETECTOR_BOTH_EYES_SYNC_WINDOW_MS = 120;

export const DEFAULT_DETECTOR_SETTINGS: DetectorSettings = {
  closeRatio: 0.7,
  reopenRatio: 0.89,
  minimumBlinkDurationMs: 100,
  maximumBlinkDurationMs: 420,
  minimumInterBlinkGapMs: 120,
  smoothingWindowSize: 5,
  baselineWindowSize: 20,
  baselineSmoothingAlpha: 0.18,
  baselineUpdateMinRatio: 0.94,
  recoveryDeltaRatio: 0.015,
  warmupDurationMs: 2000,
  plausibleEarMin: 0.12,
  plausibleEarMax: 0.5,
  maxLeftRightDifference: 0.08,
  maxLeftRightDifferenceDownward: 0.12,
  maxLeftRightDifferenceDuringBlink: 0.18,
  downwardPitchThresholdDeg: -8,
  maxYawForStableDeg: 22,
  maxRollForStableDeg: 18,
  poseTransitionGuardMs: 250
};

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 }
  }
};

export const DB_NAME = 'blink-tracker-db';
export const DB_VERSION = 2;
