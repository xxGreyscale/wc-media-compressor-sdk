import type { ImageCompressionOptions, CompressedImageOutput, ImageOutputFormat } from "./types";
import {
  IMAGE_MIME_TYPES,
  IMAGE_FORMAT_EXTENSIONS,
  LOSSLESS_FORMATS,
  TARGET_SIZE_SEARCH_ITERATIONS,
  DEFAULT_IMAGE_QUALITY,
} from "./constants";
import { computeOutputDimensions } from "./utils";

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

async function binarySearchQuality(
  canvas: HTMLCanvasElement,
  mimeType: string,
  targetBytes: number,
): Promise<Blob> {
  let lo = 0.05;
  let hi = 1.0;
  let bestBlob: Blob | null = null;

  for (let i = 0; i < TARGET_SIZE_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const blob = await canvasToBlob(canvas, mimeType, mid);
    if (blob.size <= targetBytes) {
      bestBlob = blob;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return bestBlob ?? (await canvasToBlob(canvas, mimeType, lo));
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
  const quality = options.quality ?? DEFAULT_IMAGE_QUALITY;
  const targetBytes = options.targetSizeKB !== undefined ? options.targetSizeKB * 1024 : undefined;
  const results: CompressedImageOutput = {};

  for (let i = 0; i < formats.length; i++) {
    const format: ImageOutputFormat = formats[i];
    const mimeType = IMAGE_MIME_TYPES[format];
    const ext = IMAGE_FORMAT_EXTENSIONS[format];
    const isLossless = LOSSLESS_FORMATS.includes(format);

    const blob =
      targetBytes !== undefined && !isLossless
        ? await binarySearchQuality(canvas, mimeType, targetBytes)
        : await canvasToBlob(canvas, mimeType, quality);

    results[format] = new File([blob], `${outputFileName}.${ext}`, {
      type: mimeType,
      lastModified: Date.now(),
    });

    onProgress?.(Math.round(((i + 1) / formats.length) * 100));
  }

  return results;
}

/**
 * Compresses an image using the browser Canvas API.
 * Throws for unsupported formats (e.g. HEIC) — callers should catch and route to ImageDecoder.
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

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    bitmap.close();
    throw new Error("Failed to get 2D canvas context.");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return compressFromCanvas(canvas, options, outputFileName, onProgress);
}
