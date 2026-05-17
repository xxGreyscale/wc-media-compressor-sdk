import type {
  ImageCompressionOptions,
  CompressedImageOutput,
  ImageOutputFormat,
  ImageCompressionPreset,
} from "./types";
import {
  IMAGE_MIME_TYPES,
  IMAGE_FORMAT_EXTENSIONS,
  TARGET_SIZE_SEARCH_ITERATIONS,
  PRESET_QUALITY,
  DEFAULT_IMAGE_PRESET,
} from "./constants";
import { computeOutputDimensions } from "./utils";
import { encodePngFromCanvas } from "./png-optimise";
import { medianCutQuantize } from "./palette-quantize";

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`canvas.toBlob returned null for "${mimeType}"`));
      },
      mimeType,
      quality,
    );
  });
}

interface PngMode {
  /**
   * Median-cut palette target colour count. `null` = skip palette quantisation
   * entirely (PNG-24 output, fully lossless within the dimension cap).
   */
  paletteColors: number | null;
  /**
   * Cap on the longer side (width or height, whichever is larger) of the PNG
   * canvas. `Infinity` = no cap. Aspect ratio is preserved; the SDK never
   * upscales. PNG-only — sibling JPEG/WebP outputs keep their original
   * dimensions.
   */
  maxLongerSide: number;
}

/**
 * Discrete PNG modes. Each cross-format preset maps 1:1 here.
 *
 * The strategy is "shrink dimensions first, then preserve as much quality as
 * possible at the smaller size." Dimension reduction is the dominant size
 * lever, so the lower presets lean on it heavily; palette colour counts stay
 * generous so the image at its new size still looks close to the original.
 *
 *  | Preset      | Longer side cap | Palette       | Output       |
 *  |-------------|-----------------|---------------|--------------|
 *  | `lossless`  | ∞ (original)    | none          | PNG-24/32    |
 *  | `high`      | 1080 px         | none          | PNG-24/32    |
 *  | `balanced`  | 720 px          | 256 adaptive  | PNG-8 palette |
 *  | `small`     | 480 px          | 256 adaptive  | PNG-8 palette |
 *  | `tiny`      | 240 px          | 128 adaptive  | PNG-8 palette |
 *
 * The pipeline (per `encodePng`): scale → OKLab median-cut + k-means + dither
 * → oxipng raw-pixel encode at level 6. No WebP precondition — dithering plus
 * a generous palette gives better perceived quality than smoothing-first.
 */
const PNG_MODES: Record<ImageCompressionPreset, PngMode> = {
  lossless: { paletteColors: null, maxLongerSide: Infinity },
  high: { paletteColors: null, maxLongerSide: 1080 },
  balanced: { paletteColors: 256, maxLongerSide: 720 },
  small: { paletteColors: 256, maxLongerSide: 480 },
  tiny: { paletteColors: 128, maxLongerSide: 240 },
};

/** Bucket a continuous quality value to the matching PNG mode. */
function qualityToPngPreset(quality: number): ImageCompressionPreset {
  if (quality >= 0.95) return "lossless";
  if (quality >= 0.85) return "high";
  if (quality >= 0.7) return "balanced";
  if (quality >= 0.5) return "small";
  return "tiny";
}

function resolvePngMode(options: ImageCompressionOptions, quality: number): PngMode {
  if (options.pngPreset) return PNG_MODES[options.pngPreset];
  return PNG_MODES[qualityToPngPreset(quality)];
}

async function encodePng(canvas: HTMLCanvasElement, mode: PngMode): Promise<Blob> {
  // 1. Cap the longer side per the preset. Done first — every subsequent step
  //    gets cheaper on a smaller canvas. Never upscales.
  const scaled = fitToMaxLongerSide(canvas, mode.maxLongerSide) ?? canvas;

  // 2. Optional adaptive palette quantisation (OKLab median-cut + k-means +
  //    Floyd–Steinberg dither). Skipped at `lossless` / `high`.
  if (mode.paletteColors !== null) {
    medianCutQuantize(scaled, mode.paletteColors);
  }

  // 3. oxipng writes the final PNG from raw pixels at level 6 with alpha
  //    optimisation — palette-mode conversion lands automatically when the
  //    canvas now has ≤ 256 unique RGBA tuples.
  const blob = await encodePngFromCanvas(scaled);

  if (scaled !== canvas) releaseCanvas(scaled);
  return blob;
}

/**
 * Scales the canvas so its longer side ≤ `maxLongerSide`, **strictly preserving
 * aspect ratio**. Returns null when no scaling is needed (input already fits,
 * or cap is Infinity) — the caller reuses the original canvas in that case.
 *
 * Aspect ratio guarantee: a single `scale` factor is derived from the longer
 * side and applied to both dimensions. The longer side becomes exactly
 * `maxLongerSide` (no rounding — it's a direct assignment); the shorter side
 * is derived from the original ratio. This means the output ratio is exactly
 * `srcW / srcH` up to sub-pixel rounding (max ½-pixel error on the short side
 * for non-standard input dimensions).
 *
 * If the shorter side would round to zero (extreme panoramic input vs. a tiny
 * cap), it's clamped to 1 — the aspect-ratio invariant breaks here, but the
 * alternative is an unusable zero-height canvas. This case is unreachable for
 * any reasonable photo input.
 */
function fitToMaxLongerSide(
  canvas: HTMLCanvasElement,
  maxLongerSide: number,
): HTMLCanvasElement | null {
  if (!isFinite(maxLongerSide)) return null;
  const srcW = canvas.width;
  const srcH = canvas.height;
  const longest = Math.max(srcW, srcH);
  if (longest <= maxLongerSide) return null;

  let w: number;
  let h: number;
  if (srcW >= srcH) {
    // Landscape / square. Width is the longer side and pins to the cap exactly.
    w = maxLongerSide;
    h = Math.max(1, Math.round((maxLongerSide * srcH) / srcW));
  } else {
    // Portrait. Height is the longer side.
    h = maxLongerSide;
    w = Math.max(1, Math.round((maxLongerSide * srcW) / srcH));
  }

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  // Browser bilinear/bicubic resampling. Cheap and good enough — the next
  // pipeline steps quantize colours anyway.
  out.getContext("2d")!.drawImage(canvas, 0, 0, w, h);
  return out;
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  // JPEG can't carry alpha — composite the source canvas onto white first so
  // transparent regions don't become black or noise.
  const flat = document.createElement("canvas");
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await canvasToBlob(flat, "image/jpeg", quality);
  releaseCanvas(flat);
  return blob;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

async function encodeToBlob(
  canvas: HTMLCanvasElement,
  format: ImageOutputFormat,
  quality: number,
  options: ImageCompressionOptions,
): Promise<Blob> {
  if (format === "png") return encodePng(canvas, resolvePngMode(options, quality));
  if (format === "jpeg") return encodeJpeg(canvas, quality);
  return canvasToBlob(canvas, "image/webp", quality);
}

async function binarySearchQuality(
  canvas: HTMLCanvasElement,
  format: ImageOutputFormat,
  targetBytes: number,
  options: ImageCompressionOptions,
): Promise<Blob> {
  let lo = 0.05;
  let hi = 1.0;
  let bestBlob: Blob | null = null;

  for (let i = 0; i < TARGET_SIZE_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const blob = await encodeToBlob(canvas, format, mid, options);
    if (blob.size <= targetBytes) {
      bestBlob = blob;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return bestBlob ?? (await encodeToBlob(canvas, format, lo, options));
}

function resolveQuality(options: ImageCompressionOptions): number {
  if (options.quality !== undefined) return options.quality;
  const preset = options.preset ?? DEFAULT_IMAGE_PRESET;
  return PRESET_QUALITY[preset];
}

/**
 * Compresses formats from an already-prepared canvas.
 * Shared by both the `createImageBitmap` path and the `ImageDecoder` (HEIC) path.
 */
export async function compressFromCanvas(
  canvas: HTMLCanvasElement,
  options: ImageCompressionOptions,
  outputFileName: string,
  onProgress?: (progress: number) => void,
): Promise<CompressedImageOutput> {
  const formats = options.outputFormats ?? ["webp"];
  const quality = resolveQuality(options);
  const targetBytes = options.targetSizeKB !== undefined ? options.targetSizeKB * 1024 : undefined;
  const results: CompressedImageOutput = {};

  for (let i = 0; i < formats.length; i++) {
    const format: ImageOutputFormat = formats[i];
    const ext = IMAGE_FORMAT_EXTENSIONS[format];

    const blob =
      targetBytes !== undefined
        ? await binarySearchQuality(canvas, format, targetBytes, options)
        : await encodeToBlob(canvas, format, quality, options);

    results[format] = new File([blob], `${outputFileName}.${ext}`, {
      type: IMAGE_MIME_TYPES[format],
      lastModified: Date.now(),
    });

    onProgress?.(Math.round(((i + 1) / formats.length) * 100));
  }

  return results;
}

/**
 * Compresses an image using the browser Canvas API.
 * Throws for unsupported formats (e.g. HEIC) — callers should catch and route to ImageDecoder.
 *
 * The intermediate canvas preserves alpha so transparent inputs survive into
 * PNG and WebP outputs. JPEG output composites onto white internally.
 */
export async function compressWithCanvas(
  file: File,
  options: ImageCompressionOptions,
  outputFileName: string,
  onProgress?: (progress: number) => void,
): Promise<CompressedImageOutput> {
  const bitmap = await createImageBitmap(file);
  const { w, h } = computeOutputDimensions(bitmap.width, bitmap.height, options);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Failed to get 2D canvas context.");
  }

  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  try {
    return await compressFromCanvas(canvas, options, outputFileName, onProgress);
  } finally {
    releaseCanvas(canvas);
  }
}
