# Local Blink Tracker

Simple local-only blink tracker for macOS Chrome using Vite, TypeScript, and MediaPipe Face Landmarker. The app runs on `localhost`, uses the webcam directly in the browser, stores sessions in IndexedDB, and exports CSV files locally.

## Stack

- Vite
- TypeScript
- `@mediapipe/tasks-vision`
- IndexedDB
- Plain CSS

## Local assets

Runtime assets are served from the repo:

- `public/assets/mediapipe/models/face_landmarker.task`
- `public/assets/mediapipe/wasm/*`

The `postinstall` script copies the MediaPipe wasm runtime files from `node_modules` into `public/assets/mediapipe/wasm`.

## macOS setup

1. Open Terminal.
2. Change into the project directory:

```bash
cd "/Users/risto/Software/Eye blink rate"
```

3. Install dependencies:

```bash
npm install
```

4. Start the local dev server:

```bash
npm run dev
```

5. Open the localhost URL printed by Vite in Google Chrome.
6. Allow Chrome webcam access when prompted.
7. Confirm the webcam preview appears.
8. Use `Start` to begin a tracking session.
9. Wait through the roughly 2 second warm-up period while the app establishes an open-eye EAR baseline.
10. Use `Stop` to save the session locally.
11. Reload the page to confirm the saved session history is restored from IndexedDB.

## Build

```bash
npm run build
```

## Verify local-only runtime

1. Open Chrome DevTools.
2. Go to the `Network` tab.
3. Reload the app.
4. Confirm requests are only for `localhost` assets such as the app bundle, MediaPipe wasm files, and the local `.task` model file.

The app should make no remote runtime API calls.

## Features

- Webcam preview
- Start and stop tracking sessions
- Live blink count
- Warm-up period with rolling open-eye baseline
- Persisted detector settings panel
- Tracking-quality states and live debug metrics
- Session timer
- Tracking state and current EAR/baseline stats
- Blink start / peak / end / duration / intensity capture
- Per-minute blink bins
- Local IndexedDB persistence
- Reload-safe session history
- Participant labels and session notes for repeated trials
- Export current/latest session blink events CSV
- Export all blink events CSV
- Export all session summaries CSV
- Export all minute bins CSV
- Clear recorded data while preserving settings
- Saved sessions table with per-session export actions

## Project structure

```text
.
├── README.md
├── index.html
├── package.json
├── public
│   └── assets
│       └── mediapipe
│           ├── models
│           │   └── face_landmarker.task
│           └── wasm
├── scripts
│   └── vendor-mediapipe.mjs
├── src
│   ├── app.ts
│   ├── camera.ts
│   ├── csv.ts
│   ├── main.ts
│   ├── mediapipe.ts
│   ├── storage.ts
│   ├── styles.css
│   ├── types.ts
│   └── blink
│       ├── constants.ts
│       ├── detector.ts
│       └── ear.ts
└── vite.config.ts
```

## Notes

- Run this app from `localhost` in Chrome. Opening `index.html` directly from the filesystem is not supported.
- Sessions are stored in the browser's IndexedDB for the current browser profile.
- CSV exports are generated locally in the browser with stable machine-readable headers.
- Clearing recorded data removes `sessions`, `blink_events`, and `minute_bins` while leaving `settings` untouched.
- Participant labels and session notes are useful for organizing repeated trials, pilot runs, or multiple participants in the same browser profile.

## Detector settings

EAR means Eye Aspect Ratio. It is a geometric ratio derived from face landmarks around each eye. Lower EAR values generally correspond to a more closed eye.

- `closeRatio`: baseline EAR multiplier used to enter blink closing.
- `reopenRatio`: baseline EAR multiplier used to confirm the eye has reopened.
- `minimumBlinkDurationMs`: shortest closure duration counted as a blink.
- `maximumBlinkDurationMs`: longest closure still counted as one blink instead of a tracking artifact or long eye closure.
- `minimumInterBlinkGapMs`: minimum gap after a completed blink before another blink can be counted.
- `smoothingWindowSize`: number of frames averaged for smoothed EAR.
- `baselineWindowSize`: number of stable frames used to update the rolling open-eye baseline.
- `baselineSmoothingAlpha`: exponential smoothing weight for baseline updates.
- `baselineUpdateMinRatio`: skips baseline updates when the current smoothed EAR is too far below the existing baseline.
- `recoveryDeltaRatio`: EAR recovery amount needed before the detector moves from closed toward reopening.
- `warmupDurationMs`: warm-up time before blink counting starts.
- `plausibleEarMin`: reject frames with implausibly low EAR values.
- `plausibleEarMax`: reject frames with implausibly high EAR values.
- `maxLeftRightDifference`: reject frames with excessive left/right EAR asymmetry.
- `maxLeftRightDifferenceDownward`: looser asymmetry limit used while the head pose bucket is downward.
- `maxLeftRightDifferenceDuringBlink`: looser asymmetry limit used once a blink is plausibly underway.
- `downwardPitchThresholdDeg`: pitch threshold used to bucket the pose as `forward` vs `downward`.
- `maxYawForStableDeg`: yaw limit allowed for stable tracking and baseline updates.
- `maxRollForStableDeg`: roll limit allowed for stable tracking and baseline updates.
- `poseTransitionGuardMs`: blocks new blink entry briefly after a pose bucket switch so screen-to-keyboard gaze changes are not misread as blinks.

## Practical tuning advice

- If normal blinks are missed, try raising `closeRatio` slightly or lowering `reopenRatio` slightly.
- If false positives occur during movement, lower `maxLeftRightDifference` and consider increasing `smoothingWindowSize`.
- If genuine blinks are being rejected because one eye closes a little earlier than the other, increase `maxLeftRightDifferenceDuringBlink`.
- If downward keyboard-looking blinks are missed, verify the debug pose bucket and adjust `downwardPitchThresholdDeg` and `maxLeftRightDifferenceDownward`.
- If looking down at the keyboard creates false blinks, increase `poseTransitionGuardMs` slightly or lower `downwardPitchThresholdDeg` so the downward bucket activates sooner.
- If the baseline drifts too quickly, lower `baselineSmoothingAlpha` or increase `baselineWindowSize`.
- If blinks feel too sensitive to jitter, increase `minimumBlinkDurationMs` a little.
- If intentional long blinks are being split or double-counted, increase `minimumInterBlinkGapMs` and verify `maximumBlinkDurationMs`.
- If the warm-up feels too short for your lighting or seating position, increase `warmupDurationMs`.

## Precision and safety notes

- Blink timestamps in milliseconds are bounded by browser timing and camera frame rate. They are useful for local analysis, but they are not sub-frame measurements.
- Forward and downward pose buckets maintain separate rolling baselines. If one bucket has not been learned yet, the detector can temporarily fall back to the other bucket while it builds the new baseline.
- Strong downward gaze shifts can temporarily veto blink entry during a recent pose transition, which helps avoid counting screen-to-keyboard eye movements as blinks.
- This app is a heuristic local blink tracker for exploratory use. It is not a medical device and should not be used for diagnosis or treatment decisions.
