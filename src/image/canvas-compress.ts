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
import { optimisePng } from "./png-optimise";
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
  /** WebP precondition quality. null = skip precondition (true lossless). */
  webpQuality: number | null;
  /** Median-cut palette target color count. null = skip palette quantization. */
  paletteColors: number | null;
}

/**
 * Discrete PNG modes. Each preset maps 1:1 here. PNG has no continuous quality
 * dial of its own — these are the operational modes the format can actually
 * deliver.
 *
 *  - `lossless` keeps every pixel. Size depends entirely on input content.
 *  - `high` does a mild WebP precondition to strip sensor noise. Stays PNG-24.
 *  - `balanced` quantizes to a 256-colour adaptive palette via median-cut.
 *    Output is PNG-8 → typically 10–15× smaller than `lossless`. Quality is
 *    excellent on photos because the palette adapts to the image content.
 *  - `small` quantizes to 128 colours. Subtle banding on smooth gradients.
 *  - `tiny` quantizes to 32 colours. Heavy banding, smallest output.
 *
 * Alpha is preserved through palette quantization (the algorithm only touches
 * RGB). Smooth alpha gradients prevent palette-mode encoding by oxipng, but
 * the quantized PNG-24 result is still much smaller than the unquantized
 * equivalent.
 */
const PNG_MODES: Record<ImageCompressionPreset, PngMode> = {
  lossless: { webpQuality: null, paletteColors: null },
  high: { webpQuality: 0.9, paletteColors: null },
  balanced: { webpQuality: 0.7, paletteColors: 256 },
  small: { webpQuality: 0.5, paletteColors: 128 },
  tiny: { webpQuality: 0.3, paletteColors: 32 },
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

async function preconditionViaWebP(
  canvas: HTMLCanvasElement,
  webpQuality: number,
): Promise<HTMLCanvasElement> {
  const webp = await canvasToBlob(canvas, "image/webp", webpQuality);
  const bitmap = await createImageBitmap(webp);
  try {
    const tmp = document.createElement("canvas");
    tmp.width = bitmap.width;
    tmp.height = bitmap.height;
    // Default `alpha: true` — preserves transparency from the source canvas.
    tmp.getContext("2d")!.drawImage(bitmap, 0, 0);
    return tmp;
  } finally {
    bitmap.close();
  }
}

async function encodePng(canvas: HTMLCanvasElement, mode: PngMode): Promise<Blob> {
  const preconditioned =
    mode.webpQuality !== null ? await preconditionViaWebP(canvas, mode.webpQuality) : canvas;
  if (mode.paletteColors !== null) {
    medianCutQuantize(preconditioned, mode.paletteColors);
  }
  const raw = await canvasToBlob(preconditioned, "image/png", 1);
  return optimisePng(raw);
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
  return canvasToBlob(flat, "image/jpeg", quality);
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

  return compressFromCanvas(canvas, options, outputFileName, onProgress);
}
