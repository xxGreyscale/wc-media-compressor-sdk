import type { ThumbnailConfig } from "./types";
import type { VideoTrackInfo, RawSample } from "../video/types";
import { extractGrayAndSat, scoreFrame } from "./frame-scoring";

export interface DecoderRefinementInput {
  videoTrack: VideoTrackInfo;
  /** Best timestamp from the coarse pass — the center of the first refinement window. */
  bestTimestamp: number;
  /** Best score from the coarse pass — beat this to register as a new winner. */
  bestScore: number;
  margin: number;
  usable: number;
  config: ThumbnailConfig;
  /** Output canvas — the matching frame is rendered here at full resolution
   *  the moment it becomes the new best. Lets us produce the final thumbnail
   *  without a second decode pass. */
  outputCtx: CanvasRenderingContext2D;
  outputWidth: number;
  outputHeight: number;
}

export interface DecoderRefinementResult {
  bestScore: number;
  bestTimestamp: number;
  /** True if a frame was actually rendered to outputCtx during refinement. */
  rendered: boolean;
}

/**
 * Runs the refinement passes using `VideoDecoder` for frame-accurate scoring.
 *
 * For each pass, we:
 *  1. Locate the keyframe at or before the window start.
 *  2. Decode every sample from there through the window end.
 *  3. Score each frame whose timestamp falls inside the window.
 *  4. When a frame becomes the new best, render it to the output canvas
 *     (full resolution) — so we never need a second decode pass for capture.
 */
export async function refineWithVideoDecoder(
  input: DecoderRefinementInput,
): Promise<DecoderRefinementResult> {
  const { videoTrack, config, outputCtx, outputWidth, outputHeight } = input;
  let { bestTimestamp, bestScore, margin, usable } = input;

  const aspectRatio = videoTrack.width / videoTrack.height;
  const analysisW = config.analysisWidth;
  const analysisH = Math.max(1, Math.round(analysisW / aspectRatio));
  const analysisCanvas = new OffscreenCanvas(analysisW, analysisH);
  const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true })!;

  const effectiveCoarse = Math.max(1, config.coarseCount);
  let stepSize = effectiveCoarse > 1 ? usable / (effectiveCoarse - 1) : usable;
  let rendered = false;

  for (const refineCount of config.refineCounts) {
    const half = stepSize / 2;
    const windowStart = Math.max(margin, bestTimestamp - half);
    const windowEnd = Math.min(margin + usable, bestTimestamp + half);

    const result = await scoreWindow(
      videoTrack,
      windowStart,
      windowEnd,
      analysisCtx,
      analysisW,
      analysisH,
      outputCtx,
      outputWidth,
      outputHeight,
      bestScore,
      bestTimestamp,
      config,
    );

    if (result.bestScore > bestScore) {
      bestScore = result.bestScore;
      bestTimestamp = result.bestTimestamp;
      rendered = result.rendered || rendered;
    } else if (result.rendered) {
      // Even if the score didn't beat the seed, the window may have rendered
      // an equal-best frame to the output canvas — track that.
      rendered = true;
    }

    stepSize = (windowEnd - windowStart) / (refineCount + 1);
  }

  return { bestScore, bestTimestamp, rendered };
}

interface WindowResult {
  bestScore: number;
  bestTimestamp: number;
  rendered: boolean;
}

async function scoreWindow(
  videoTrack: VideoTrackInfo,
  windowStartSec: number,
  windowEndSec: number,
  analysisCtx: OffscreenCanvasRenderingContext2D,
  analysisW: number,
  analysisH: number,
  outputCtx: CanvasRenderingContext2D,
  outputW: number,
  outputH: number,
  seedScore: number,
  seedTimestamp: number,
  config: ThumbnailConfig,
): Promise<WindowResult> {
  const { keyframeIdx, endIdx } = locateSampleRange(
    videoTrack.samples,
    windowStartSec,
    windowEndSec,
  );

  if (keyframeIdx === -1) {
    return { bestScore: seedScore, bestTimestamp: seedTimestamp, rendered: false };
  }

  let bestScore = seedScore;
  let bestTimestamp = seedTimestamp;
  let rendered = false;
  let decoderError: Error | undefined;

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (decoderError) {
        frame.close();
        return;
      }
      try {
        const tSec = frame.timestamp / 1_000_000;
        if (tSec >= windowStartSec && tSec <= windowEndSec) {
          analysisCtx.drawImage(frame, 0, 0, analysisW, analysisH);
          const { data } = analysisCtx.getImageData(0, 0, analysisW, analysisH);
          const { gray, sat } = extractGrayAndSat(data, analysisW * analysisH);
          const score = scoreFrame(gray, sat, analysisW, analysisH, config);

          if (score > bestScore) {
            bestScore = score;
            bestTimestamp = tSec;
            // Capture this frame as the candidate thumbnail at full resolution.
            outputCtx.drawImage(frame, 0, 0, outputW, outputH);
            rendered = true;
          }
        }
      } finally {
        frame.close();
      }
    },
    error: (e) => { decoderError = e; },
  });

  decoder.configure({
    codec: videoTrack.codec,
    codedWidth: videoTrack.width,
    codedHeight: videoTrack.height,
    ...(videoTrack.description ? { description: videoTrack.description } : {}),
  });

  for (let i = keyframeIdx; i <= endIdx; i++) {
    if (decoderError) break;
    const s = videoTrack.samples[i];
    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? "key" : "delta",
      timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
      duration: Math.round((s.duration / s.timescale) * 1_000_000),
      data: s.data,
    }));
  }

  await decoder.flush();
  decoder.close();

  if (decoderError) throw decoderError;

  return { bestScore, bestTimestamp, rendered };
}

/**
 * Finds the sample range to feed the decoder for a given time window:
 *   - keyframeIdx: the last keyframe at or before windowStart (decode entry point)
 *   - endIdx:      the last sample whose timestamp is at or before windowEnd
 *
 * Returns `{ keyframeIdx: -1, endIdx: -1 }` if the window contains no samples.
 */
function locateSampleRange(
  samples: RawSample[],
  windowStartSec: number,
  windowEndSec: number,
): { keyframeIdx: number; endIdx: number } {
  let keyframeIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < samples.length; i++) {
    const tSec = samples[i].cts / samples[i].timescale;
    if (tSec > windowEndSec) break;
    if (tSec <= windowStartSec && samples[i].is_sync) keyframeIdx = i;
    if (tSec <= windowEndSec) endIdx = i;
  }

  // If we never found a keyframe before the window but there are samples in
  // the window, fall back to the first keyframe in or after the window start.
  if (keyframeIdx === -1) {
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].is_sync) {
        const tSec = samples[i].cts / samples[i].timescale;
        if (tSec <= windowEndSec) {
          keyframeIdx = i;
          break;
        }
      }
    }
  }

  return { keyframeIdx, endIdx };
}

/**
 * Decodes a single specific timestamp and renders the matching frame to
 * the output canvas. Used as a fallback when refinement finds no
 * improvement over the coarse winner — we still need to render *something*.
 */
export async function captureFrameAt(
  videoTrack: VideoTrackInfo,
  targetSec: number,
  outputCtx: CanvasRenderingContext2D,
  outputW: number,
  outputH: number,
): Promise<void> {
  const { keyframeIdx, endIdx } = locateSampleRange(
    videoTrack.samples,
    targetSec,
    targetSec,
  );

  if (keyframeIdx === -1) {
    throw new Error(`No keyframe found at or before ${targetSec}s.`);
  }

  // Extend endIdx to the first sample at or after targetSec (we need to decode
  // through the target timestamp; locateSampleRange may have given us an
  // earlier sample if no sample falls exactly on targetSec).
  let actualEndIdx = endIdx;
  for (let i = endIdx + 1; i < videoTrack.samples.length; i++) {
    actualEndIdx = i;
    const tSec = videoTrack.samples[i].cts / videoTrack.samples[i].timescale;
    if (tSec >= targetSec) break;
  }

  let captured = false;
  let decoderError: Error | undefined;
  let closestFrame: { delta: number } = { delta: Infinity };

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (decoderError) {
        frame.close();
        return;
      }
      try {
        const tSec = frame.timestamp / 1_000_000;
        const delta = Math.abs(tSec - targetSec);
        // Keep the frame closest to the target timestamp.
        if (delta < closestFrame.delta) {
          closestFrame = { delta };
          outputCtx.drawImage(frame, 0, 0, outputW, outputH);
          captured = true;
        }
      } finally {
        frame.close();
      }
    },
    error: (e) => { decoderError = e; },
  });

  decoder.configure({
    codec: videoTrack.codec,
    codedWidth: videoTrack.width,
    codedHeight: videoTrack.height,
    ...(videoTrack.description ? { description: videoTrack.description } : {}),
  });

  for (let i = keyframeIdx; i <= actualEndIdx; i++) {
    if (decoderError) break;
    const s = videoTrack.samples[i];
    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? "key" : "delta",
      timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
      duration: Math.round((s.duration / s.timescale) * 1_000_000),
      data: s.data,
    }));
  }

  await decoder.flush();
  decoder.close();

  if (decoderError) throw decoderError;
  if (!captured) throw new Error(`Failed to decode any frame near ${targetSec}s.`);
}
