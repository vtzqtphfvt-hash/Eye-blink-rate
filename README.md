# Eye Blink Rate Tracker

Browser-based blink tracking app built with Vite, TypeScript, and MediaPipe Face Landmarker. It runs locally in the browser, uses the webcam directly, stores session data in IndexedDB, and exports blink data as CSV.

## Overview

This project measures blink activity from a live webcam feed using Eye Aspect Ratio (EAR) derived from facial landmarks. The detector is designed for interactive desktop use and includes:

- Real-time webcam preview
- Live blink counting
- Warm-up period for baseline calibration
- Adjustable detector settings
- Tracking-quality and debug metrics
- Session history stored locally in the browser
- CSV export for blink events, session summaries, and minute bins

The app is intended for local exploratory use, prototyping, and personal research workflows. It is not a medical device.

## Tech Stack

- Vite
- TypeScript
- `@mediapipe/tasks-vision`
- IndexedDB
- Plain CSS

## Privacy and Runtime Model

- The app runs locally in the browser on `localhost`.
- Webcam access is handled directly by the browser.
- Session data is stored in the browser's IndexedDB for the current browser profile.
- CSV exports are generated locally in the browser.
- The runtime is designed to avoid remote API calls during use.

MediaPipe model and wasm assets are served from this repository:

- `public/assets/mediapipe/models/face_landmarker.task`
- `public/assets/mediapipe/wasm/*`

The `postinstall` script copies the required MediaPipe wasm runtime files from `node_modules` into `public/assets/mediapipe/wasm`.

## Requirements

- Node.js 20+ recommended
- npm
- A modern Chromium-based browser with webcam support

Google Chrome is the primary target environment.

## Clone and Install

```bash
git clone https://github.com/vtzqtphfvt-hash/Eye-blink-rate.git
cd Eye-blink-rate
npm install
```

## Quick Start

```bash
npm run dev
```

Then:

1. Open the local URL printed by Vite.
2. Allow webcam access when prompted.
3. Confirm the preview is visible.
4. Select `Start` to begin a session.
5. Wait through the warm-up period while the detector establishes an open-eye baseline.
6. Select `Stop` to save the session locally.

## Available Scripts

```bash
npm run dev
npm run build
npm run preview
```

## Features

- Webcam preview and local session control
- Start/stop tracking workflow
- Live blink count and session timer
- Rolling open-eye baseline calibration
- Blink start, peak, end, duration, and intensity capture
- Per-minute blink bins
- Participant labels and session notes
- Persisted detector settings
- Tracking-quality states and debug metrics
- Reload-safe IndexedDB session history
- CSV export for:
  - Current session blink events
  - All blink events
  - All session summaries
  - All minute bins
- Clear-recorded-data action that preserves detector settings

## Detector Summary

Blink detection is based on Eye Aspect Ratio (EAR), a geometric measure derived from eye landmarks. Lower EAR values generally correspond to a more closed eye.

This implementation goes beyond a fixed threshold detector. It includes:

- Rolling EAR smoothing
- Warm-up calibration
- Separate forward and downward pose baselines
- Pose and asymmetry stability checks
- Recovery logic to reduce false positives
- Duration and inter-blink gap constraints

## Detector Settings

- `closeRatio`: Baseline EAR multiplier used to enter blink closing
- `reopenRatio`: Baseline EAR multiplier used to confirm reopening
- `minimumBlinkDurationMs`: Minimum closure duration counted as a blink
- `maximumBlinkDurationMs`: Maximum closure duration still treated as a blink
- `minimumInterBlinkGapMs`: Minimum gap required between blinks
- `smoothingWindowSize`: Number of frames averaged for EAR smoothing
- `baselineWindowSize`: Number of stable frames used for baseline updates
- `baselineSmoothingAlpha`: Exponential smoothing weight for baseline updates
- `baselineUpdateMinRatio`: Minimum ratio required before baseline updates are accepted
- `recoveryDeltaRatio`: EAR recovery amount needed before reopening
- `warmupDurationMs`: Warm-up period before blink counting starts
- `plausibleEarMin`: Lower bound for plausible EAR values
- `plausibleEarMax`: Upper bound for plausible EAR values
- `maxLeftRightDifference`: Open-eye asymmetry tolerance
- `maxLeftRightDifferenceDownward`: Looser asymmetry tolerance for downward pose
- `maxLeftRightDifferenceDuringBlink`: Looser asymmetry tolerance during plausible blink phases
- `downwardPitchThresholdDeg`: Pitch threshold used to classify downward pose
- `maxYawForStableDeg`: Maximum yaw allowed for stable tracking
- `maxRollForStableDeg`: Maximum roll allowed for stable tracking
- `poseTransitionGuardMs`: Guard interval after pose changes to reduce false blink entry

## Practical Tuning Notes

- If blinks are missed, raise `closeRatio` slightly or lower `reopenRatio`.
- If movement causes false positives, lower `maxLeftRightDifference` and consider increasing `smoothingWindowSize`.
- If one eye often closes earlier than the other, increase `maxLeftRightDifferenceDuringBlink`.
- If downward-looking blinks are missed, inspect pose/debug metrics and adjust `downwardPitchThresholdDeg` or `maxLeftRightDifferenceDownward`.
- If baseline drift feels too aggressive, lower `baselineSmoothingAlpha` or increase `baselineWindowSize`.
- If blink detection feels too jittery, increase `minimumBlinkDurationMs`.

## Data Model

The app stores these categories locally:

- `sessions`
- `blink_events`
- `minute_bins`
- `settings`

Clearing recorded data removes session-derived records while preserving detector settings.

## Project Structure

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

## Build

```bash
npm run build
```

## Browser Notes

- Run the app through the Vite dev server or another local HTTP server.
- Opening `index.html` directly from the filesystem is not supported.
- Browser support depends on webcam permissions and MediaPipe runtime compatibility.

## Limitations

- Blink timestamps are limited by browser timing and camera frame rate.
- Accuracy depends on lighting, camera quality, framing, pose, and individual eye geometry.
- The detector is heuristic and intended for exploratory use rather than diagnosis or treatment.

## Development Notes

- This repository vendors the MediaPipe runtime assets needed for local execution.
- If dependencies are reinstalled, `postinstall` refreshes the wasm runtime files under `public/assets/mediapipe/wasm`.
