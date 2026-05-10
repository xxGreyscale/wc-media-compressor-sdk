import type { ThumbnailConfig, ThumbnailQuality } from "./types";

/**
 * Thumbnail extraction presets.
 *
 * The pipeline is hybrid:
 *   - Coarse scan uses `<video>` element seeking (keyframe-accurate, fast).
 *   - Refinement passes use the WebCodecs `VideoDecoder` (frame-accurate).
 *
 * `coarseCount` controls how many evenly-spaced timestamps are scored in the
 * first pass. `refineCounts` controls how aggressively the search window
 * narrows on each subsequent pass — VideoDecoder scores every actual frame
 * within each narrowed window, so the value affects only window narrowing.
 *
 * | Preset         | Coarse | Window narrows | Analysis | Output max |
 * |----------------|--------|----------------|----------|------------|
 * | `performance`  | 8      | /5, /3         | 240 px   | 960 px     |
 * | `balanced`     | 24     | /9, /5         | 480 px   | 1280 px    |
 * | `quality`      | 40     | /17, /9        | 640 px   | 1920 px    |
 * | `best-quality` | 56     | /33, /17       | 960 px   | 2560 px    |
 */
export const THUMBNAIL_PRESETS: Readonly<Record<ThumbnailQuality, ThumbnailConfig>> = {
  /**
   * Fastest preset. Smallest analysis canvas, narrowest VideoDecoder windows.
   * Best for bulk uploads where latency matters more than picking the perfect frame.
   */
  performance: {
    coarseCount: 8,
    refineCounts: [4, 2],
    analysisWidth: 240,
    thumbnailMaxWidth: 960,
    thumbnailQuality: 0.85,
    videoMarginPercent: 0.05,
    minMeanLum: 0.06,
    maxMeanLum: 0.93,
    minStdDev: 0.02,
    brightnessPeak: 0.45,
    brightnessPenaltyFactor: 2.8,
    centerRegionPercent: 0.2,
    centerSharpnessWeight: 0.7,
    fullSharpnessWeight: 0.3,
  },

  /**
   * Balanced default. Suitable for most upload pipelines.
   * Decodes ~50–150 actual frames during refinement.
   */
  balanced: {
    coarseCount: 24,
    refineCounts: [8, 4],
    analysisWidth: 480,
    thumbnailMaxWidth: 1280,
    thumbnailQuality: 0.92,
    videoMarginPercent: 0.05,
    minMeanLum: 0.06,
    maxMeanLum: 0.93,
    minStdDev: 0.02,
    brightnessPeak: 0.45,
    brightnessPenaltyFactor: 2.8,
    centerRegionPercent: 0.15,
    centerSharpnessWeight: 0.8,
    fullSharpnessWeight: 0.2,
  },

  /**
   * High-quality preset. Larger analysis canvas, broader refinement windows.
   * Decodes ~150–400 actual frames during refinement.
   */
  quality: {
    coarseCount: 40,
    refineCounts: [16, 8],
    analysisWidth: 640,
    thumbnailMaxWidth: 1920,
    thumbnailQuality: 0.95,
    videoMarginPercent: 0.05,
    minMeanLum: 0.06,
    maxMeanLum: 0.93,
    minStdDev: 0.02,
    brightnessPeak: 0.45,
    brightnessPenaltyFactor: 2.8,
    centerRegionPercent: 0.12,
    centerSharpnessWeight: 0.85,
    fullSharpnessWeight: 0.15,
  },

  /**
   * Maximum quality preset. Highest analysis resolution and broadest
   * refinement windows. Decodes ~400–1000 actual frames during refinement.
   */
  "best-quality": {
    coarseCount: 56,
    refineCounts: [32, 16],
    analysisWidth: 960,
    thumbnailMaxWidth: 2560,
    thumbnailQuality: 0.98,
    videoMarginPercent: 0.05,
    minMeanLum: 0.06,
    maxMeanLum: 0.93,
    minStdDev: 0.02,
    brightnessPeak: 0.45,
    brightnessPenaltyFactor: 2.8,
    centerRegionPercent: 0.1,
    centerSharpnessWeight: 0.9,
    fullSharpnessWeight: 0.1,
  },
} as const;

/** Default configuration — resolves to the `balanced` preset. */
export const DEFAULT_THUMBNAIL_CONFIG: ThumbnailConfig = THUMBNAIL_PRESETS.balanced;
