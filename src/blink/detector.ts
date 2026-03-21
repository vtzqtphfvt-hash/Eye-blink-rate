import {
  DETECTOR_BLINK_PHASE_UNSTABLE_TOLERANCE_FRAMES,
  DETECTOR_BOTH_EYES_SYNC_WINDOW_MS,
  DETECTOR_STABLE_RECOVERY_FRAMES
} from './constants';
import type { DetectorSettings, PoseBucket, TrackingQualityState } from '../types';

const DOWNWARD_STABLE_FRAMES_BEFORE_BLINK = 4;
const STRONG_DOWNWARD_GAZE_SCORE = 0.62;
const GAZE_SHIFT_DELTA = 0.08;
const GAZE_SHIFT_EAR_DROP_RATIO = 0.92;

export type BlinkPhase = 'idle' | 'closing' | 'closed' | 'reopening';

export interface BlinkSample {
  leftEar: number;
  rightEar: number;
  combinedEar: number;
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
  gazeDownwardScore: number | null;
  hasGazeEstimate: boolean;
  frameIndex: number;
  faceTracked: boolean;
  sessionElapsedMs: number;
}

export interface BlinkDraft {
  blinkIndex: number;
  startMs: number;
  peakMs: number;
  endMs: number;
  durationMs: number;
  timeFromSessionStartMs: number;
  leftEarMin: number;
  rightEarMin: number;
  combinedEarMin: number;
  baselineEar: number;
  intensity: number;
  interBlinkIntervalMs: number | null;
}

export interface BlinkDetectionResult {
  phase: BlinkPhase;
  trackingQualityState: TrackingQualityState;
  poseBucket: PoseBucket;
  faceTracked: boolean;
  trackingStable: boolean;
  baselineEar: number | null;
  baselineForwardEar: number | null;
  baselineDownwardEar: number | null;
  activeBaselineEar: number | null;
  smoothedLeftEar: number;
  smoothedRightEar: number;
  smoothedCombinedEar: number;
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
  asymmetryDifference: number;
  asymmetryRejectionActive: boolean;
  blinkPhaseAsymmetryToleranceActive: boolean;
  closeThresholdEar: number | null;
  reopenThresholdEar: number | null;
  stableRecoveryFrames: number;
  unstableReason: string | null;
  timeSinceLastPoseBucketSwitchMs: number;
  poseTransitionGuardActive: boolean;
  gazeShiftVetoActive: boolean;
  blinkEntryBlockedByPoseStabilization: boolean;
  blink?: BlinkDraft;
}

interface BlinkCandidate {
  startMs: number;
  peakMs: number;
  leftEarMin: number;
  rightEarMin: number;
  combinedEarMin: number;
  baselineEar: number;
  combinedThresholdCrossed: boolean;
  leftClosedAtMs: number | null;
  rightClosedAtMs: number | null;
}

interface InstabilityInfo {
  kind: 'no_face' | 'plausibility' | 'asymmetry' | 'pose';
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pushWindow(window: number[], value: number, maxLength: number): number {
  window.push(value);

  if (window.length > maxLength) {
    window.shift();
  }

  return window.reduce((sum, entry) => sum + entry, 0) / window.length;
}

function copyLastValue(window: number[]): number {
  return window.at(-1) ?? 0;
}

function isRecoverySatisfied(stableFrameStreak: number, recoveringFromUnstableTracking: boolean): boolean {
  return !recoveringFromUnstableTracking || stableFrameStreak >= DETECTOR_STABLE_RECOVERY_FRAMES;
}

export class BlinkDetector {
  private readonly config: DetectorSettings;
  private phase: BlinkPhase = 'idle';
  private baselineForwardEar: number | null = null;
  private baselineDownwardEar: number | null = null;
  private readonly baselineForwardWindow: number[] = [];
  private readonly baselineDownwardWindow: number[] = [];
  private readonly leftWindow: number[] = [];
  private readonly rightWindow: number[] = [];
  private readonly combinedWindow: number[] = [];
  private candidate: BlinkCandidate | null = null;
  private previousSmoothedCombinedEar: number | null = null;
  private previousGazeDownwardScore: number | null = null;
  private currentPoseBucket: PoseBucket | null = null;
  private lastPoseBucketSwitchMs = 0;
  private stableFramesInCurrentPoseBucket = 0;
  private lastBlinkPeakMs: number | null = null;
  private lastBlinkEndMs: number | null = null;
  private blinkCount = 0;
  private stableFrameStreak = 0;
  private recoveringFromUnstableTracking = false;
  private unstableReason: string | null = null;
  private toleratedBlinkPhaseUnstableFrames = 0;

  constructor(config: DetectorSettings) {
    this.config = config;
  }

  reset(): void {
    this.phase = 'idle';
    this.baselineForwardEar = null;
    this.baselineDownwardEar = null;
    this.baselineForwardWindow.length = 0;
    this.baselineDownwardWindow.length = 0;
    this.leftWindow.length = 0;
    this.rightWindow.length = 0;
    this.combinedWindow.length = 0;
    this.candidate = null;
    this.previousSmoothedCombinedEar = null;
    this.previousGazeDownwardScore = null;
    this.currentPoseBucket = null;
    this.lastPoseBucketSwitchMs = 0;
    this.stableFramesInCurrentPoseBucket = 0;
    this.lastBlinkPeakMs = null;
    this.lastBlinkEndMs = null;
    this.blinkCount = 0;
    this.stableFrameStreak = 0;
    this.recoveringFromUnstableTracking = false;
    this.unstableReason = null;
    this.toleratedBlinkPhaseUnstableFrames = 0;
  }

  update(sample: BlinkSample): BlinkDetectionResult {
    const smoothedLeftEar =
      sample.faceTracked && Number.isFinite(sample.leftEar)
        ? pushWindow(this.leftWindow, sample.leftEar, this.config.smoothingWindowSize)
        : copyLastValue(this.leftWindow);
    const smoothedRightEar =
      sample.faceTracked && Number.isFinite(sample.rightEar)
        ? pushWindow(this.rightWindow, sample.rightEar, this.config.smoothingWindowSize)
        : copyLastValue(this.rightWindow);
    const smoothedCombinedEar =
      sample.faceTracked && Number.isFinite(sample.combinedEar)
        ? pushWindow(this.combinedWindow, sample.combinedEar, this.config.smoothingWindowSize)
        : copyLastValue(this.combinedWindow);

    const poseBucket = this.getPoseBucket(sample.pitchDeg);
    this.updatePoseState(poseBucket, sample.sessionElapsedMs);

    const timeSinceLastPoseBucketSwitchMs = Math.max(0, sample.sessionElapsedMs - this.lastPoseBucketSwitchMs);
    const poseTransitionGuardActive = timeSinceLastPoseBucketSwitchMs < this.config.poseTransitionGuardMs;
    const activeBaselineEar =
      this.getBaselineForPoseBucket(poseBucket) ??
      this.getFallbackBaseline(poseBucket) ??
      smoothedCombinedEar;
    const closeThresholdEar = activeBaselineEar * this.config.closeRatio;
    const reopenThresholdEar = activeBaselineEar * this.config.reopenRatio;
    const individualCloseThresholdEar = activeBaselineEar * this.config.closeRatio;
    const asymmetryDifference = Math.abs(sample.leftEar - sample.rightEar);
    const downwardBaselineReady =
      this.baselineDownwardEar !== null &&
      this.baselineDownwardWindow.length >= Math.min(6, this.config.baselineWindowSize);
    const blinkEntryBlockedByPoseStabilization =
      this.phase === 'idle' &&
      poseBucket === 'downward' &&
      (poseTransitionGuardActive ||
        !downwardBaselineReady ||
        this.stableFramesInCurrentPoseBucket < DOWNWARD_STABLE_FRAMES_BEFORE_BLINK);
    const gazeShiftVetoActive = this.isGazeShiftVetoActive(
      sample.gazeDownwardScore,
      activeBaselineEar,
      smoothedCombinedEar,
      poseBucket,
      poseTransitionGuardActive,
      blinkEntryBlockedByPoseStabilization
    );
    const blinkContextActive =
      this.phase !== 'idle' ||
      this.didCombinedThresholdCross(closeThresholdEar, smoothedCombinedEar) ||
      this.didBothEyesCloseSimultaneously(smoothedLeftEar, smoothedRightEar, individualCloseThresholdEar);
    const blinkPhaseAsymmetryToleranceActive =
      blinkContextActive &&
      asymmetryDifference > this.getOpenEyeAsymmetryLimit(poseBucket) &&
      asymmetryDifference <= this.config.maxLeftRightDifferenceDuringBlink;
    const instability = this.getInstabilityInfo(
      sample,
      smoothedCombinedEar,
      poseBucket,
      blinkContextActive,
      asymmetryDifference
    );

    if (instability !== null) {
      if (this.shouldTolerateInstability(instability, blinkContextActive)) {
        this.toleratedBlinkPhaseUnstableFrames += 1;

        if (this.toleratedBlinkPhaseUnstableFrames <= DETECTOR_BLINK_PHASE_UNSTABLE_TOLERANCE_FRAMES) {
          this.startOrUpdateCandidateIfNeeded(
            sample.sessionElapsedMs,
            smoothedLeftEar,
            smoothedRightEar,
            smoothedCombinedEar,
            activeBaselineEar,
            closeThresholdEar,
            individualCloseThresholdEar,
            blinkEntryBlockedByPoseStabilization || gazeShiftVetoActive
          );
          this.previousSmoothedCombinedEar = smoothedCombinedEar || this.previousSmoothedCombinedEar;
          this.unstableReason = `Tolerating temporary ${instability.reason.toLowerCase()} during blink.`;

          return this.finalizeResult(
            {
              phase: this.phase,
              trackingQualityState: 'blink_in_progress',
              poseBucket,
              faceTracked: sample.faceTracked,
              trackingStable: true,
              baselineEar: activeBaselineEar,
              baselineForwardEar: this.baselineForwardEar,
              baselineDownwardEar: this.baselineDownwardEar,
              activeBaselineEar,
              smoothedLeftEar,
              smoothedRightEar,
              smoothedCombinedEar,
              pitchDeg: sample.pitchDeg,
              yawDeg: sample.yawDeg,
              rollDeg: sample.rollDeg,
              asymmetryDifference,
              asymmetryRejectionActive: instability.kind === 'asymmetry',
              blinkPhaseAsymmetryToleranceActive: true,
              closeThresholdEar,
              reopenThresholdEar,
              stableRecoveryFrames: this.stableFrameStreak,
              unstableReason: this.unstableReason,
              timeSinceLastPoseBucketSwitchMs,
              poseTransitionGuardActive,
              gazeShiftVetoActive,
              blinkEntryBlockedByPoseStabilization
            },
            sample
          );
        }
      }

      this.handleUnstableSample(instability.reason);
      this.previousSmoothedCombinedEar = smoothedCombinedEar || this.previousSmoothedCombinedEar;

      return this.finalizeResult(
        {
          phase: this.phase,
          trackingQualityState: sample.faceTracked ? 'tracking_unstable' : 'no_face',
          poseBucket,
          faceTracked: sample.faceTracked,
          trackingStable: false,
          baselineEar: activeBaselineEar,
          baselineForwardEar: this.baselineForwardEar,
          baselineDownwardEar: this.baselineDownwardEar,
          activeBaselineEar,
          smoothedLeftEar,
          smoothedRightEar,
          smoothedCombinedEar,
          pitchDeg: sample.pitchDeg,
          yawDeg: sample.yawDeg,
          rollDeg: sample.rollDeg,
          asymmetryDifference,
          asymmetryRejectionActive: instability.kind === 'asymmetry',
          blinkPhaseAsymmetryToleranceActive,
          closeThresholdEar,
          reopenThresholdEar,
          stableRecoveryFrames: this.stableFrameStreak,
          unstableReason: this.unstableReason,
          timeSinceLastPoseBucketSwitchMs,
          poseTransitionGuardActive,
          gazeShiftVetoActive,
          blinkEntryBlockedByPoseStabilization
        },
        sample
      );
    }

    this.unstableReason = null;
    this.stableFrameStreak += 1;
    this.toleratedBlinkPhaseUnstableFrames = 0;
    this.stableFramesInCurrentPoseBucket += 1;

    if (
      this.phase === 'idle' &&
      (this.isWarmingUp(sample.sessionElapsedMs, poseBucket) ||
        isRecoverySatisfied(this.stableFrameStreak, this.recoveringFromUnstableTracking))
    ) {
      this.updateBaseline(smoothedCombinedEar, poseBucket);
    }

    const refreshedBaselineEar =
      this.getBaselineForPoseBucket(poseBucket) ??
      this.getFallbackBaseline(poseBucket) ??
      activeBaselineEar;
    const refreshedCloseThresholdEar = refreshedBaselineEar * this.config.closeRatio;
    const refreshedReopenThresholdEar = refreshedBaselineEar * this.config.reopenRatio;
    const refreshedIndividualCloseThresholdEar = refreshedBaselineEar * this.config.closeRatio;
    const refreshedBlockedByPoseStabilization =
      this.phase === 'idle' &&
      poseBucket === 'downward' &&
      (poseTransitionGuardActive ||
        !(
          this.baselineDownwardEar !== null &&
          this.baselineDownwardWindow.length >= Math.min(6, this.config.baselineWindowSize)
        ) ||
        this.stableFramesInCurrentPoseBucket < DOWNWARD_STABLE_FRAMES_BEFORE_BLINK);
    const refreshedGazeShiftVetoActive = this.isGazeShiftVetoActive(
      sample.gazeDownwardScore,
      refreshedBaselineEar,
      smoothedCombinedEar,
      poseBucket,
      poseTransitionGuardActive,
      refreshedBlockedByPoseStabilization
    );

    if (this.isWarmingUp(sample.sessionElapsedMs, poseBucket)) {
      this.phase = 'idle';
      this.candidate = null;
      this.previousSmoothedCombinedEar = smoothedCombinedEar;

      return this.finalizeResult(
        {
          phase: this.phase,
          trackingQualityState: 'warming_up',
          poseBucket,
          faceTracked: sample.faceTracked,
          trackingStable: true,
          baselineEar: refreshedBaselineEar,
          baselineForwardEar: this.baselineForwardEar,
          baselineDownwardEar: this.baselineDownwardEar,
          activeBaselineEar: refreshedBaselineEar,
          smoothedLeftEar,
          smoothedRightEar,
          smoothedCombinedEar,
          pitchDeg: sample.pitchDeg,
          yawDeg: sample.yawDeg,
          rollDeg: sample.rollDeg,
          asymmetryDifference,
          asymmetryRejectionActive: false,
          blinkPhaseAsymmetryToleranceActive,
          closeThresholdEar: refreshedCloseThresholdEar,
          reopenThresholdEar: refreshedReopenThresholdEar,
          stableRecoveryFrames: this.stableFrameStreak,
          unstableReason: null,
          timeSinceLastPoseBucketSwitchMs,
          poseTransitionGuardActive,
          gazeShiftVetoActive: refreshedGazeShiftVetoActive,
          blinkEntryBlockedByPoseStabilization: refreshedBlockedByPoseStabilization
        },
        sample
      );
    }

    if (!isRecoverySatisfied(this.stableFrameStreak, this.recoveringFromUnstableTracking)) {
      this.phase = 'idle';
      this.candidate = null;
      this.previousSmoothedCombinedEar = smoothedCombinedEar;

      return this.finalizeResult(
        {
          phase: this.phase,
          trackingQualityState: 'stabilizing',
          poseBucket,
          faceTracked: sample.faceTracked,
          trackingStable: false,
          baselineEar: refreshedBaselineEar,
          baselineForwardEar: this.baselineForwardEar,
          baselineDownwardEar: this.baselineDownwardEar,
          activeBaselineEar: refreshedBaselineEar,
          smoothedLeftEar,
          smoothedRightEar,
          smoothedCombinedEar,
          pitchDeg: sample.pitchDeg,
          yawDeg: sample.yawDeg,
          rollDeg: sample.rollDeg,
          asymmetryDifference,
          asymmetryRejectionActive: false,
          blinkPhaseAsymmetryToleranceActive,
          closeThresholdEar: refreshedCloseThresholdEar,
          reopenThresholdEar: refreshedReopenThresholdEar,
          stableRecoveryFrames: this.stableFrameStreak,
          unstableReason: null,
          timeSinceLastPoseBucketSwitchMs,
          poseTransitionGuardActive,
          gazeShiftVetoActive: refreshedGazeShiftVetoActive,
          blinkEntryBlockedByPoseStabilization: refreshedBlockedByPoseStabilization
        },
        sample
      );
    }

    if (this.phase === 'idle' && (refreshedBlockedByPoseStabilization || refreshedGazeShiftVetoActive)) {
      this.previousSmoothedCombinedEar = smoothedCombinedEar;

      return this.finalizeResult(
        {
          phase: this.phase,
          trackingQualityState: 'stabilizing',
          poseBucket,
          faceTracked: sample.faceTracked,
          trackingStable: true,
          baselineEar: refreshedBaselineEar,
          baselineForwardEar: this.baselineForwardEar,
          baselineDownwardEar: this.baselineDownwardEar,
          activeBaselineEar: refreshedBaselineEar,
          smoothedLeftEar,
          smoothedRightEar,
          smoothedCombinedEar,
          pitchDeg: sample.pitchDeg,
          yawDeg: sample.yawDeg,
          rollDeg: sample.rollDeg,
          asymmetryDifference,
          asymmetryRejectionActive: false,
          blinkPhaseAsymmetryToleranceActive,
          closeThresholdEar: refreshedCloseThresholdEar,
          reopenThresholdEar: refreshedReopenThresholdEar,
          stableRecoveryFrames: this.stableFrameStreak,
          unstableReason: refreshedGazeShiftVetoActive
            ? 'Downward gaze shift detected. Blink entry temporarily vetoed.'
            : 'Blink entry blocked while downward pose stabilizes.',
          timeSinceLastPoseBucketSwitchMs,
          poseTransitionGuardActive,
          gazeShiftVetoActive: refreshedGazeShiftVetoActive,
          blinkEntryBlockedByPoseStabilization: refreshedBlockedByPoseStabilization
        },
        sample
      );
    }

    this.recoveringFromUnstableTracking = false;

    const recoveryDelta = refreshedBaselineEar * this.config.recoveryDeltaRatio;
    let blink: BlinkDraft | undefined;

    switch (this.phase) {
      case 'idle':
        if (
          this.canStartBlink(sample.sessionElapsedMs) &&
          this.isBlinkStartSignal(
            smoothedLeftEar,
            smoothedRightEar,
            smoothedCombinedEar,
            refreshedCloseThresholdEar,
            refreshedIndividualCloseThresholdEar
          )
        ) {
          this.phase = 'closing';
          this.candidate = {
            startMs: sample.sessionElapsedMs,
            peakMs: sample.sessionElapsedMs,
            leftEarMin: smoothedLeftEar,
            rightEarMin: smoothedRightEar,
            combinedEarMin: smoothedCombinedEar,
            baselineEar: refreshedBaselineEar,
            combinedThresholdCrossed: smoothedCombinedEar <= refreshedCloseThresholdEar,
            leftClosedAtMs: smoothedLeftEar <= refreshedIndividualCloseThresholdEar ? sample.sessionElapsedMs : null,
            rightClosedAtMs: smoothedRightEar <= refreshedIndividualCloseThresholdEar ? sample.sessionElapsedMs : null
          };
        }
        break;
      case 'closing':
        this.updateCandidate(
          sample.sessionElapsedMs,
          smoothedLeftEar,
          smoothedRightEar,
          smoothedCombinedEar,
          refreshedCloseThresholdEar,
          refreshedIndividualCloseThresholdEar
        );

        if (this.hasExceededBlinkDuration(sample.sessionElapsedMs)) {
          this.resetCandidate();
          break;
        }

        if (smoothedCombinedEar > refreshedCloseThresholdEar && this.candidate?.combinedThresholdCrossed) {
          this.resetCandidate();
          break;
        }

        if (
          this.previousSmoothedCombinedEar !== null &&
          smoothedCombinedEar >= this.previousSmoothedCombinedEar &&
          this.candidate
        ) {
          this.phase = 'closed';
        }
        break;
      case 'closed':
        this.updateCandidate(
          sample.sessionElapsedMs,
          smoothedLeftEar,
          smoothedRightEar,
          smoothedCombinedEar,
          refreshedCloseThresholdEar,
          refreshedIndividualCloseThresholdEar
        );

        if (this.hasExceededBlinkDuration(sample.sessionElapsedMs)) {
          this.resetCandidate();
          break;
        }

        if (this.candidate && smoothedCombinedEar >= this.candidate.combinedEarMin + recoveryDelta) {
          this.phase = 'reopening';
        }
        break;
      case 'reopening':
        this.updateCandidate(
          sample.sessionElapsedMs,
          smoothedLeftEar,
          smoothedRightEar,
          smoothedCombinedEar,
          refreshedCloseThresholdEar,
          refreshedIndividualCloseThresholdEar
        );

        if (this.hasExceededBlinkDuration(sample.sessionElapsedMs)) {
          this.resetCandidate();
          break;
        }

        if (smoothedCombinedEar <= refreshedCloseThresholdEar && this.candidate?.combinedThresholdCrossed) {
          this.phase = 'closed';
          break;
        }

        if (smoothedCombinedEar >= refreshedReopenThresholdEar && this.candidate) {
          const durationMs = sample.sessionElapsedMs - this.candidate.startMs;
          const bothEyesClosedTogether = this.didBothEyesCloseInSync(this.candidate);

          if (
            durationMs >= this.config.minimumBlinkDurationMs &&
            durationMs <= this.config.maximumBlinkDurationMs &&
            (this.candidate.combinedThresholdCrossed || bothEyesClosedTogether)
          ) {
            this.blinkCount += 1;
            const interBlinkIntervalMs =
              this.lastBlinkPeakMs === null ? null : this.candidate.peakMs - this.lastBlinkPeakMs;
            const intensity = clamp(
              (this.candidate.baselineEar - this.candidate.combinedEarMin) / this.candidate.baselineEar,
              0,
              1
            );

            blink = {
              blinkIndex: this.blinkCount,
              startMs: this.candidate.startMs,
              peakMs: this.candidate.peakMs,
              endMs: sample.sessionElapsedMs,
              durationMs,
              timeFromSessionStartMs: this.candidate.peakMs,
              leftEarMin: this.candidate.leftEarMin,
              rightEarMin: this.candidate.rightEarMin,
              combinedEarMin: this.candidate.combinedEarMin,
              baselineEar: this.candidate.baselineEar,
              intensity,
              interBlinkIntervalMs
            };

            this.lastBlinkPeakMs = this.candidate.peakMs;
            this.lastBlinkEndMs = sample.sessionElapsedMs;
          }

          this.resetCandidate();
        }
        break;
    }

    this.previousSmoothedCombinedEar = smoothedCombinedEar;

    return this.finalizeResult(
      {
        phase: this.phase,
        trackingQualityState: this.phase === 'idle' ? 'tracking_stable' : 'blink_in_progress',
        poseBucket,
        faceTracked: sample.faceTracked,
        trackingStable: true,
        baselineEar: refreshedBaselineEar,
        baselineForwardEar: this.baselineForwardEar,
        baselineDownwardEar: this.baselineDownwardEar,
        activeBaselineEar: refreshedBaselineEar,
        smoothedLeftEar,
        smoothedRightEar,
        smoothedCombinedEar,
        pitchDeg: sample.pitchDeg,
        yawDeg: sample.yawDeg,
        rollDeg: sample.rollDeg,
        asymmetryDifference,
        asymmetryRejectionActive: false,
        blinkPhaseAsymmetryToleranceActive,
        closeThresholdEar: refreshedCloseThresholdEar,
        reopenThresholdEar: refreshedReopenThresholdEar,
        stableRecoveryFrames: this.stableFrameStreak,
        unstableReason: null,
        timeSinceLastPoseBucketSwitchMs,
        poseTransitionGuardActive,
        gazeShiftVetoActive: refreshedGazeShiftVetoActive,
        blinkEntryBlockedByPoseStabilization: refreshedBlockedByPoseStabilization,
        blink
      },
      sample
    );
  }

  private finalizeResult(result: BlinkDetectionResult, sample: BlinkSample): BlinkDetectionResult {
    this.previousGazeDownwardScore = sample.hasGazeEstimate ? sample.gazeDownwardScore : null;
    return result;
  }

  private updatePoseState(poseBucket: PoseBucket, sessionElapsedMs: number): void {
    if (this.currentPoseBucket === null) {
      this.currentPoseBucket = poseBucket;
      this.lastPoseBucketSwitchMs = sessionElapsedMs;
      this.stableFramesInCurrentPoseBucket = 0;
      return;
    }

    if (poseBucket !== this.currentPoseBucket) {
      this.currentPoseBucket = poseBucket;
      this.lastPoseBucketSwitchMs = sessionElapsedMs;
      this.stableFramesInCurrentPoseBucket = 0;
    }
  }

  private getPoseBucket(pitchDeg: number): PoseBucket {
    return pitchDeg < this.config.downwardPitchThresholdDeg ? 'downward' : 'forward';
  }

  private getBaselineForPoseBucket(poseBucket: PoseBucket): number | null {
    return poseBucket === 'downward' ? this.baselineDownwardEar : this.baselineForwardEar;
  }

  private getFallbackBaseline(poseBucket: PoseBucket): number | null {
    return poseBucket === 'downward' ? this.baselineForwardEar : this.baselineDownwardEar;
  }

  private getOpenEyeAsymmetryLimit(poseBucket: PoseBucket): number {
    return poseBucket === 'downward'
      ? this.config.maxLeftRightDifferenceDownward
      : this.config.maxLeftRightDifference;
  }

  private shouldTolerateInstability(instability: InstabilityInfo, blinkContextActive: boolean): boolean {
    return blinkContextActive && (this.phase !== 'idle' || instability.kind === 'asymmetry' || instability.kind === 'plausibility');
  }

  private handleUnstableSample(reason: string): void {
    this.unstableReason = reason;
    this.stableFrameStreak = 0;
    this.recoveringFromUnstableTracking = true;
    this.toleratedBlinkPhaseUnstableFrames = 0;
    this.stableFramesInCurrentPoseBucket = 0;
    this.resetCandidate();
  }

  private isGazeShiftVetoActive(
    gazeDownwardScore: number | null,
    activeBaselineEar: number,
    smoothedCombinedEar: number,
    poseBucket: PoseBucket,
    poseTransitionGuardActive: boolean,
    blinkEntryBlockedByPoseStabilization: boolean
  ): boolean {
    if (this.phase !== 'idle' || poseBucket !== 'downward' || gazeDownwardScore === null || this.previousGazeDownwardScore === null) {
      return false;
    }

    const gazeShiftDelta = gazeDownwardScore - this.previousGazeDownwardScore;

    return (
      (poseTransitionGuardActive || blinkEntryBlockedByPoseStabilization) &&
      gazeDownwardScore >= STRONG_DOWNWARD_GAZE_SCORE &&
      gazeShiftDelta >= GAZE_SHIFT_DELTA &&
      smoothedCombinedEar <= activeBaselineEar * GAZE_SHIFT_EAR_DROP_RATIO
    );
  }

  private getInstabilityInfo(
    sample: BlinkSample,
    smoothedCombinedEar: number,
    poseBucket: PoseBucket,
    blinkContextActive: boolean,
    asymmetryDifference: number
  ): InstabilityInfo | null {
    if (!sample.faceTracked) {
      return { kind: 'no_face', reason: 'No face detected' };
    }

    if (Math.abs(sample.yawDeg) > this.config.maxYawForStableDeg) {
      return { kind: 'pose', reason: 'Yaw too large for stable tracking' };
    }

    if (Math.abs(sample.rollDeg) > this.config.maxRollForStableDeg) {
      return { kind: 'pose', reason: 'Roll too large for stable tracking' };
    }

    const leftPlausible = this.isPlausibleEar(sample.leftEar);
    const rightPlausible = this.isPlausibleEar(sample.rightEar);
    const combinedPlausible = this.isPlausibleEar(sample.combinedEar) && this.isPlausibleEar(smoothedCombinedEar);

    if (!combinedPlausible) {
      return { kind: 'plausibility', reason: 'Combined EAR implausible' };
    }

    if (!blinkContextActive) {
      if (!leftPlausible) {
        return { kind: 'plausibility', reason: 'Left EAR implausible' };
      }

      if (!rightPlausible) {
        return { kind: 'plausibility', reason: 'Right EAR implausible' };
      }
    } else if (!leftPlausible && !rightPlausible) {
      return { kind: 'plausibility', reason: 'Both eyes implausible during blink' };
    }

    const maxDifference = blinkContextActive
      ? this.config.maxLeftRightDifferenceDuringBlink
      : this.getOpenEyeAsymmetryLimit(poseBucket);

    if (asymmetryDifference > maxDifference) {
      return { kind: 'asymmetry', reason: 'Left/right EAR asymmetry too high' };
    }

    return null;
  }

  private isPlausibleEar(value: number): boolean {
    return Number.isFinite(value) && value >= this.config.plausibleEarMin && value <= this.config.plausibleEarMax;
  }

  private updateBaseline(smoothedCombinedEar: number, poseBucket: PoseBucket): void {
    const baselineWindow = poseBucket === 'downward' ? this.baselineDownwardWindow : this.baselineForwardWindow;
    const currentBaseline = poseBucket === 'downward' ? this.baselineDownwardEar : this.baselineForwardEar;

    if (currentBaseline !== null && smoothedCombinedEar < currentBaseline * this.config.baselineUpdateMinRatio) {
      return;
    }

    const windowMean = pushWindow(baselineWindow, smoothedCombinedEar, this.config.baselineWindowSize);
    const nextBaseline =
      currentBaseline === null
        ? windowMean
        : currentBaseline * (1 - this.config.baselineSmoothingAlpha) + windowMean * this.config.baselineSmoothingAlpha;

    if (poseBucket === 'downward') {
      this.baselineDownwardEar = nextBaseline;
    } else {
      this.baselineForwardEar = nextBaseline;
    }
  }

  private isWarmingUp(sessionElapsedMs: number, poseBucket: PoseBucket): boolean {
    const baselineWindow = poseBucket === 'downward' ? this.baselineDownwardWindow : this.baselineForwardWindow;
    const activeBaseline = this.getBaselineForPoseBucket(poseBucket);
    const fallbackBaseline = this.getFallbackBaseline(poseBucket);

    return (
      sessionElapsedMs < this.config.warmupDurationMs ||
      (activeBaseline === null && fallbackBaseline === null) ||
      (activeBaseline !== null && baselineWindow.length < Math.min(6, this.config.baselineWindowSize))
    );
  }

  private canStartBlink(sessionElapsedMs: number): boolean {
    return this.lastBlinkEndMs === null || sessionElapsedMs - this.lastBlinkEndMs >= this.config.minimumInterBlinkGapMs;
  }

  private didCombinedThresholdCross(closeThresholdEar: number, smoothedCombinedEar: number): boolean {
    return this.previousSmoothedCombinedEar !== null
      ? this.previousSmoothedCombinedEar > closeThresholdEar && smoothedCombinedEar <= closeThresholdEar
      : smoothedCombinedEar <= closeThresholdEar;
  }

  private didBothEyesCloseSimultaneously(
    smoothedLeftEar: number,
    smoothedRightEar: number,
    individualCloseThresholdEar: number
  ): boolean {
    return smoothedLeftEar <= individualCloseThresholdEar && smoothedRightEar <= individualCloseThresholdEar;
  }

  private isBlinkStartSignal(
    smoothedLeftEar: number,
    smoothedRightEar: number,
    smoothedCombinedEar: number,
    closeThresholdEar: number,
    individualCloseThresholdEar: number
  ): boolean {
    return (
      this.didCombinedThresholdCross(closeThresholdEar, smoothedCombinedEar) ||
      this.didBothEyesCloseSimultaneously(smoothedLeftEar, smoothedRightEar, individualCloseThresholdEar)
    );
  }

  private startOrUpdateCandidateIfNeeded(
    sessionElapsedMs: number,
    smoothedLeftEar: number,
    smoothedRightEar: number,
    smoothedCombinedEar: number,
    baselineEar: number,
    closeThresholdEar: number,
    individualCloseThresholdEar: number,
    blinkEntryBlocked: boolean
  ): void {
    if (blinkEntryBlocked) {
      return;
    }

    if (
      this.phase === 'idle' &&
      this.canStartBlink(sessionElapsedMs) &&
      this.isBlinkStartSignal(
        smoothedLeftEar,
        smoothedRightEar,
        smoothedCombinedEar,
        closeThresholdEar,
        individualCloseThresholdEar
      )
    ) {
      this.phase = 'closing';
      this.candidate = {
        startMs: sessionElapsedMs,
        peakMs: sessionElapsedMs,
        leftEarMin: smoothedLeftEar,
        rightEarMin: smoothedRightEar,
        combinedEarMin: smoothedCombinedEar,
        baselineEar,
        combinedThresholdCrossed: smoothedCombinedEar <= closeThresholdEar,
        leftClosedAtMs: smoothedLeftEar <= individualCloseThresholdEar ? sessionElapsedMs : null,
        rightClosedAtMs: smoothedRightEar <= individualCloseThresholdEar ? sessionElapsedMs : null
      };
      return;
    }

    if (this.phase !== 'idle') {
      this.updateCandidate(
        sessionElapsedMs,
        smoothedLeftEar,
        smoothedRightEar,
        smoothedCombinedEar,
        closeThresholdEar,
        individualCloseThresholdEar
      );
    }
  }

  private updateCandidate(
    sessionElapsedMs: number,
    smoothedLeftEar: number,
    smoothedRightEar: number,
    smoothedCombinedEar: number,
    closeThresholdEar: number,
    individualCloseThresholdEar: number
  ): void {
    if (!this.candidate) {
      return;
    }

    if (smoothedCombinedEar <= this.candidate.combinedEarMin) {
      this.candidate.combinedEarMin = smoothedCombinedEar;
      this.candidate.leftEarMin = smoothedLeftEar;
      this.candidate.rightEarMin = smoothedRightEar;
      this.candidate.peakMs = sessionElapsedMs;
    }

    if (smoothedCombinedEar <= closeThresholdEar) {
      this.candidate.combinedThresholdCrossed = true;
    }

    if (this.candidate.leftClosedAtMs === null && smoothedLeftEar <= individualCloseThresholdEar) {
      this.candidate.leftClosedAtMs = sessionElapsedMs;
    }

    if (this.candidate.rightClosedAtMs === null && smoothedRightEar <= individualCloseThresholdEar) {
      this.candidate.rightClosedAtMs = sessionElapsedMs;
    }
  }

  private didBothEyesCloseInSync(candidate: BlinkCandidate): boolean {
    return (
      candidate.leftClosedAtMs !== null &&
      candidate.rightClosedAtMs !== null &&
      Math.abs(candidate.leftClosedAtMs - candidate.rightClosedAtMs) <= DETECTOR_BOTH_EYES_SYNC_WINDOW_MS
    );
  }

  private hasExceededBlinkDuration(sessionElapsedMs: number): boolean {
    return this.candidate !== null && sessionElapsedMs - this.candidate.startMs > this.config.maximumBlinkDurationMs;
  }

  private resetCandidate(): void {
    this.phase = 'idle';
    this.candidate = null;
  }
}
