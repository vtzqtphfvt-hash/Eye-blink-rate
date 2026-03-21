import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_ROOT = '/assets/mediapipe/wasm';
const MODEL_PATH = '/assets/mediapipe/models/face_landmarker.task';

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export async function loadFaceLandmarker(): Promise<FaceLandmarker> {
  if (landmarkerPromise) {
    return landmarkerPromise;
  }

  landmarkerPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);

    return FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        delegate: 'CPU'
      },
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      runningMode: 'VIDEO'
    });
  })();

  return landmarkerPromise;
}
