export interface ThumbnailResult {
  blob: Blob;
  timestampSeconds: number;
}

export type ThumbnailQuality = "performance" | "balanced" | "quality" | "best-quality";

export interface ThumbnailConfig {
  coarseCount: number;
  refineCounts: readonly [number, number];
  analysisWidth: number;
  thumbnailMaxWidth: number;
  thumbnailQuality: number;
  videoMarginPercent: number;
  minMeanLum: number;
  maxMeanLum: number;
  minStdDev: number;
  brightnessPeak: number;
  brightnessPenaltyFactor: number;
  centerRegionPercent: number;
  centerSharpnessWeight: number;
  fullSharpnessWeight: number;
}

export interface ThumbnailOptions {
  quality?: ThumbnailQuality;
  config?: Partial<ThumbnailConfig>;
}
