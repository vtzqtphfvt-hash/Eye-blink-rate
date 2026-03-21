import { LEFT_EYE_INDICES, RIGHT_EYE_INDICES } from './constants';

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2
});

const averagePoint = (points: Array<{ x: number; y: number }>) => {
  const total = points.reduce(
    (sum, point) => ({
      x: sum.x + point.x,
      y: sum.y + point.y
    }),
    { x: 0, y: 0 }
  );

  return {
    x: total.x / points.length,
    y: total.y / points.length
  };
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeEyeAspectRatio(
  landmarks: ArrayLike<{ x: number; y: number }>,
  indices: readonly [number, number, number, number, number, number]
): number {
  const [p1, p2, p3, p4, p5, p6] = indices;
  const horizontal = distance(landmarks[p1], landmarks[p4]);

  if (horizontal === 0) {
    return 0;
  }

  const vertical = distance(landmarks[p2], landmarks[p6]) + distance(landmarks[p3], landmarks[p5]);
  return vertical / (2 * horizontal);
}

export interface EarReading {
  leftEar: number;
  rightEar: number;
  combinedEar: number;
}

export interface HeadPoseEstimate {
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
}

export interface EyeGazeEstimate {
  leftDownwardRatio: number | null;
  rightDownwardRatio: number | null;
  downwardScore: number | null;
  hasIrisData: boolean;
}

export function computeEarReadings(landmarks: ArrayLike<{ x: number; y: number }>): EarReading {
  const leftEar = computeEyeAspectRatio(landmarks, LEFT_EYE_INDICES);
  const rightEar = computeEyeAspectRatio(landmarks, RIGHT_EYE_INDICES);

  return {
    leftEar,
    rightEar,
    combinedEar: (leftEar + rightEar) / 2
  };
}

export function estimateHeadPose(landmarks: ArrayLike<{ x: number; y: number }>): HeadPoseEstimate {
  const leftEyeOuter = landmarks[33];
  const rightEyeOuter = landmarks[263];
  const eyeMidpoint = midpoint(leftEyeOuter, rightEyeOuter);
  const mouthMidpoint = midpoint(landmarks[13], landmarks[14]);
  const noseTip = landmarks[1];
  const faceLeft = landmarks[234];
  const faceRight = landmarks[454];

  const rollDeg = (Math.atan2(rightEyeOuter.y - leftEyeOuter.y, rightEyeOuter.x - leftEyeOuter.x) * 180) / Math.PI;
  const faceHalfWidth = Math.max(1e-6, Math.abs(faceRight.x - faceLeft.x) / 2);
  const faceCenterX = (faceLeft.x + faceRight.x) / 2;
  const yawRatio = clamp((noseTip.x - faceCenterX) / faceHalfWidth, -0.95, 0.95);
  const yawDeg = (Math.asin(yawRatio) * 180) / Math.PI;
  const verticalSpan = Math.max(1e-6, mouthMidpoint.y - eyeMidpoint.y);
  const noseVerticalRatio = (noseTip.y - eyeMidpoint.y) / verticalSpan;
  const pitchDeg = (noseVerticalRatio - 0.56) * 120;

  return {
    pitchDeg,
    yawDeg,
    rollDeg
  };
}

export function estimateEyeGaze(landmarks: ArrayLike<{ x: number; y: number }>): EyeGazeEstimate {
  if (landmarks.length < 478) {
    return {
      leftDownwardRatio: null,
      rightDownwardRatio: null,
      downwardScore: null,
      hasIrisData: false
    };
  }

  const leftTop = averagePoint([landmarks[160], landmarks[158]]);
  const leftBottom = averagePoint([landmarks[153], landmarks[144]]);
  const rightTop = averagePoint([landmarks[385], landmarks[387]]);
  const rightBottom = averagePoint([landmarks[373], landmarks[380]]);
  const leftIrisCenter = averagePoint([
    landmarks[468],
    landmarks[469],
    landmarks[470],
    landmarks[471],
    landmarks[472]
  ]);
  const rightIrisCenter = averagePoint([
    landmarks[473],
    landmarks[474],
    landmarks[475],
    landmarks[476],
    landmarks[477]
  ]);
  const leftVerticalSpan = Math.max(1e-6, leftBottom.y - leftTop.y);
  const rightVerticalSpan = Math.max(1e-6, rightBottom.y - rightTop.y);
  const leftDownwardRatio = clamp((leftIrisCenter.y - leftTop.y) / leftVerticalSpan, 0, 1);
  const rightDownwardRatio = clamp((rightIrisCenter.y - rightTop.y) / rightVerticalSpan, 0, 1);

  return {
    leftDownwardRatio,
    rightDownwardRatio,
    downwardScore: (leftDownwardRatio + rightDownwardRatio) / 2,
    hasIrisData: true
  };
}
