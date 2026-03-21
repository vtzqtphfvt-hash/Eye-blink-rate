import { CAMERA_CONSTRAINTS } from './blink/constants';

async function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onLoadedData = () => {
      video.removeEventListener('loadeddata', onLoadedData);
      resolve();
    };

    video.addEventListener('loadeddata', onLoadedData);
  });
}

export class CameraController {
  private stream: MediaStream | null = null;

  async start(video: HTMLVideoElement): Promise<void> {
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      video.srcObject = this.stream;
      video.playsInline = true;
      video.muted = true;
      await video.play();
      await waitForVideoReady(video);
      return;
    }

    video.srcObject = this.stream;
    await video.play();
    await waitForVideoReady(video);
  }

  stop(video: HTMLVideoElement): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }

    this.stream = null;
    video.pause();
    video.srcObject = null;
  }

  get isActive(): boolean {
    return this.stream !== null;
  }
}
