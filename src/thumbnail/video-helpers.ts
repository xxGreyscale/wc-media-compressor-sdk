import type { ThumbnailConfig } from "./types";
import { extractGrayAndSat, scoreFrame } from "./frame-scoring";

export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
    video.currentTime = time;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob returned null"));
      },
      "image/jpeg",
      quality,
    );
  });
}

export async function scoreTimestamps(
  timestamps: number[],
  video: HTMLVideoElement,
  analysisCtx: CanvasRenderingContext2D,
  analysisW: number,
  analysisH: number,
  config: ThumbnailConfig,
): Promise<{ bestScore: number; bestTimestamp: number }> {
  let bestScore = -Infinity;
  let bestTimestamp = timestamps[0];

  for (const ts of timestamps) {
    await seekTo(video, ts);
    analysisCtx.drawImage(video, 0, 0, analysisW, analysisH);
    const { data } = analysisCtx.getImageData(0, 0, analysisW, analysisH);
    const { gray, sat } = extractGrayAndSat(data, analysisW * analysisH);
    const score = scoreFrame(gray, sat, analysisW, analysisH, config);
    if (score > bestScore) {
      bestScore = score;
      bestTimestamp = ts;
    }
  }

  return { bestScore, bestTimestamp };
}

export function generateCoarseTimestamps(
  duration: number,
  config: ThumbnailConfig,
): { margin: number; usable: number; timestamps: number[] } {
  const margin = duration * config.videoMarginPercent;
  const usable = duration - margin * 2;
  const effectiveCoarse = Math.max(1, config.coarseCount);

  const timestamps = Array.from({ length: effectiveCoarse }, (_, i) =>
    effectiveCoarse === 1
      ? margin + usable / 2
      : margin + (usable / (effectiveCoarse - 1)) * i,
  );

  return { margin, usable, timestamps };
}

export function generateRefineTimestamps(start: number, end: number, refineCount: number): number[] {
  return Array.from(
    { length: refineCount },
    (_, i) => start + ((end - start) / (refineCount + 1)) * (i + 1),
  );
}

export async function performRefinementPasses(
  bestTimestamp: number,
  bestScore: number,
  margin: number,
  usable: number,
  video: HTMLVideoElement,
  analysisCtx: CanvasRenderingContext2D,
  analysisW: number,
  analysisH: number,
  config: ThumbnailConfig,
): Promise<{ bestScore: number; bestTimestamp: number }> {
  let currentBestTimestamp = bestTimestamp;
  let currentBestScore = bestScore;

  const effectiveCoarse = Math.max(1, config.coarseCount);
  let stepSize = effectiveCoarse > 1 ? usable / (effectiveCoarse - 1) : usable;

  for (const refineCount of config.refineCounts) {
    const half = stepSize / 2;
    const start = Math.max(margin, currentBestTimestamp - half);
    const end = Math.min(margin + usable, currentBestTimestamp + half);

    const refineTimestamps = generateRefineTimestamps(start, end, refineCount);
    const result = await scoreTimestamps(refineTimestamps, video, analysisCtx, analysisW, analysisH, config);

    if (result.bestScore > currentBestScore) {
      currentBestScore = result.bestScore;
      currentBestTimestamp = result.bestTimestamp;
    }

    stepSize = (end - start) / (refineCount + 1);
  }

  return { bestScore: currentBestScore, bestTimestamp: currentBestTimestamp };
}
