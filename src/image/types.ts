export type ImageOutputFormat = "jpeg" | "webp" | "png";

/**
 * Cross-format intent presets.
 *
 * Each preset maps to:
 *  - a `quality` value for JPEG/WebP (continuous lossy codecs)
 *  - a discrete operational mode for PNG (lossless/palette/etc.)
 *
 * Picking a preset is the recommended API. Pass `quality` directly only when
 * you need fine-grained control over JPEG/WebP — for PNG, the SDK still
 * buckets the value into the same modes (PNG doesn't have a continuous quality
 * knob, no matter what we expose).
 *
 * | Preset      | JPEG/WebP q | PNG behavior                          |
 * |-------------|-------------|---------------------------------------|
 * | `lossless`  | 1.00        | True lossless PNG-24/32 + oxipng      |
 * | `high`      | 0.90        | PNG-24, mild WebP precondition        |
 * | `balanced`  | 0.80        | 6-bit posterize, ~262 k colors        |
 * | `small`     | 0.60        | 5-bit posterize, ~32 k colors         |
 * | `tiny`      | 0.40        | 3-bit posterize → PNG-8 palette mode  |
 */
export type ImageCompressionPreset = "lossless" | "high" | "balanced" | "small" | "tiny";

export interface ImageCompressionOptions {
  outputFileName?: string;
  outputFormats?: ImageOutputFormat[];
  /**
   * Cross-format quality intent. Resolves to a `quality` value for JPEG/WebP
   * and to a discrete PNG mode. Overridden by an explicit `quality`.
   * @default "balanced"
   */
  preset?: ImageCompressionPreset;
  /**
   * Continuous quality 0–1. For JPEG/WebP this is passed straight to the
   * encoder. For PNG it's bucketed into the preset modes — quality < 0.30
   * triggers PNG-8 palette mode.
   *
   * When omitted, derived from `preset` (default `balanced` → 0.80).
   */
  quality?: number;
  /**
   * Force a specific PNG mode regardless of `quality` / `preset`. Use to
   * guarantee lossless PNG (`"lossless"`) or maximally aggressive output
   * (`"tiny"`) without affecting JPEG/WebP outputs in the same call.
   */
  pngPreset?: ImageCompressionPreset;
  /**
   * Target output file size in KB per format.
   * Quality is automatically adjusted via binary search to fit. For PNG the
   * search varies the precondition quality across the same preset buckets.
   */
  targetSizeKB?: number;
  maxWidth?: number;
  maxHeight?: number;
  width?: number;
  height?: number;
}

export interface CompressedImageOutput {
  [format: string]: File;
}

export interface BatchImageCompressionItem {
  file: File;
  options?: ImageCompressionOptions;
  onProgress?: (progress: number) => void;
}

export interface BatchImageCompressionResult {
  file: File;
  output?: CompressedImageOutput;
  error?: Error;
}
