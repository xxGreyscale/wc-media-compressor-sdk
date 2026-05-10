import type { ThumbnailResult, ThumbnailQuality, ThumbnailOptions, ThumbnailConfig } from "./types";
import { THUMBNAIL_PRESETS, DEFAULT_THUMBNAIL_CONFIG } from "./constants";
import {
  seekTo,
  canvasToBlob,
  scoreTimestamps,
  generateCoarseTimestamps,
  performRefinementPasses,
} from "./video-helpers";
import { refineWithVideoDecoder, captureFrameAt } from "./decoder-refinement";
import { demux } from "../video/demux";
import type { DemuxResult } from "../video/types";

function resolveConfig(options?: ThumbnailQuality | ThumbnailOptions): ThumbnailConfig {
  const preset =
    typeof options === "string"
      ? THUMBNAIL_PRESETS[options]
      : options?.quality
        ? THUMBNAIL_PRESETS[options.quality]
        : DEFAULT_THUMBNAIL_CONFIG;

  const overrides = typeof options === "object" ? options.config : undefined;
  return overrides ? { ...preset, ...overrides } : preset;
}

/**
 * Extracts the most representative frame from a video as a JPEG thumbnail.
 *
 * **Hybrid pipeline:**
 *  1. **Coarse scan** — `<video>` element seeks across N evenly-spaced
 *     timestamps. Fast and keyframe-accurate, which is fine at this granularity.
 *  2. **Refinement passes** — `VideoDecoder` (WebCodecs) decodes every actual
 *     frame in the narrowed search window for **frame-accurate** scoring.
 *     This is where the hybrid approach beats a pure `<video>` pipeline:
 *     `<video>` seeking returns the nearest keyframe, so refining within a
 *     sub-keyframe window with it would re-score the same frame repeatedly.
 *  3. **Final capture** — the best frame is rendered to the output canvas
 *     during refinement (no second decode pass).
 *
 * Falls back to a pure `<video>` pipeline if mp4box demux fails (e.g. the
 * input isn't an MP4/MOV the demuxer can parse).
 */
export async function extractThumbnail(
  file: File,
  options?: ThumbnailQuality | ThumbnailOptions,
): Promise<ThumbnailResult> {
  const config = resolveConfig(options);
  const objectUrl = URL.createObjectURL(file);

  try {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";

    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Failed to load video for thumbnail extraction")), { once: true });
      video.src = objectUrl;
    });

    const { duration, videoWidth, videoHeight } = video;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error("Could not determine video duration.");
    }

    const { margin, usable, timestamps: coarseTimestamps } = generateCoarseTimestamps(duration, config);

    const aspectRatio = videoWidth / videoHeight;
    const analysisH = Math.max(1, Math.round(config.analysisWidth / aspectRatio));
    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = config.analysisWidth;
    analysisCanvas.height = analysisH;
    const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true })!;

    // Output canvas — final thumbnail is drawn here.
    const outW = Math.min(videoWidth, config.thumbnailMaxWidth);
    const outH = Math.round(outW / aspectRatio);
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = outW;
    thumbCanvas.height = outH;
    const thumbCtx = thumbCanvas.getContext("2d")!;

    // Coarse scan + demux run in parallel — they're independent operations.
    const [coarse, demuxResult] = await Promise.all([
      scoreTimestamps(coarseTimestamps, video, analysisCtx, config.analysisWidth, analysisH, config),
      demux(file).catch((): DemuxResult | null => null),
    ]);

    let { bestScore, bestTimestamp } = coarse;

    if (demuxResult) {
      // Hybrid path: VideoDecoder-based refinement.
      const refined = await refineWithVideoDecoder({
        videoTrack: demuxResult.video,
        bestTimestamp,
        bestScore,
        margin,
        usable,
        config,
        outputCtx: thumbCtx,
        outputWidth: outW,
        outputHeight: outH,
      });

      bestScore = refined.bestScore;
      bestTimestamp = refined.bestTimestamp;

      // If refinement never beat the coarse winner's score, the output canvas
      // is empty — render the coarse winner via a single VideoDecoder pass.
      if (!refined.rendered) {
        await captureFrameAt(demuxResult.video, bestTimestamp, thumbCtx, outW, outH);
      }
    } else {
      // Fallback: pure <video> pipeline (refinement won't beat keyframe accuracy).
      const refined = await performRefinementPasses(
        bestTimestamp, bestScore, margin, usable,
        video, analysisCtx, config.analysisWidth, analysisH, config,
      );
      bestScore = refined.bestScore;
      bestTimestamp = refined.bestTimestamp;

      await seekTo(video, bestTimestamp);
      thumbCtx.drawImage(video, 0, 0, outW, outH);
    }

    const blob = await canvasToBlob(thumbCanvas, config.thumbnailQuality);
    return { blob, timestampSeconds: bestTimestamp };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export type { ThumbnailResult, ThumbnailQuality, ThumbnailConfig, ThumbnailOptions } from "./types";
