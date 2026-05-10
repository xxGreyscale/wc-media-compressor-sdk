import type {
  ImageCompressionOptions,
  CompressedImageOutput,
  BatchImageCompressionItem,
  BatchImageCompressionResult,
} from "./types";
import { DEFAULT_IMAGE_OUTPUT_FORMATS, DEFAULT_IMAGE_QUALITY } from "./constants";
import { isHeicFile, getBaseName } from "./utils";
import { compressWithCanvas } from "./canvas-compress";
import { compressWithImageDecoder } from "./imagedecoder-compress";
import { ConcurrencyLimiter } from "../shared/concurrency";

export type {
  ImageCompressionOptions,
  CompressedImageOutput,
  BatchImageCompressionItem,
  BatchImageCompressionResult,
  ImageOutputFormat,
} from "./types";

function resolveOptions(options?: ImageCompressionOptions): ImageCompressionOptions {
  return {
    outputFormats: DEFAULT_IMAGE_OUTPUT_FORMATS,
    quality: DEFAULT_IMAGE_QUALITY,
    ...options,
  };
}

/**
 * Compresses a single image file.
 *
 * - HEIC/HEIF (iPhone photos) are decoded with the WebCodecs `ImageDecoder` API
 *   — no WASM, no server round-trip.
 * - All other formats use the Canvas API (`createImageBitmap`).
 * - If Canvas cannot decode the file, `ImageDecoder` is tried as a fallback.
 *
 * Outputs JPEG, WebP, or PNG — configurable via `options.outputFormats`.
 */
export async function compressImage(
  file: File,
  options?: ImageCompressionOptions,
  onProgress?: (progress: number) => void,
): Promise<CompressedImageOutput> {
  const resolved = resolveOptions(options);
  const outputFileName = resolved.outputFileName ?? `${getBaseName(file.name)}-compressed`;

  if (isHeicFile(file)) {
    return compressWithImageDecoder(file, resolved, outputFileName, onProgress);
  }

  try {
    return await compressWithCanvas(file, resolved, outputFileName, onProgress);
  } catch {
    // Canvas could not decode the file — try ImageDecoder as a fallback.
    return compressWithImageDecoder(file, resolved, outputFileName, onProgress);
  }
}

/**
 * Compresses multiple image files concurrently.
 * Never throws — errors are captured per result item.
 *
 * @param maxConcurrency Maximum parallel compressions. Default: 5.
 */
export async function compressImages(
  items: BatchImageCompressionItem[],
  maxConcurrency = 5,
): Promise<BatchImageCompressionResult[]> {
  const limiter = new ConcurrencyLimiter(maxConcurrency);

  return Promise.all(
    items.map((item) =>
      limiter.run(async (): Promise<BatchImageCompressionResult> => {
        try {
          const output = await compressImage(item.file, item.options, item.onProgress);
          return { file: item.file, output };
        } catch (err) {
          return { file: item.file, error: err instanceof Error ? err : new Error(String(err)) };
        }
      }),
    ),
  );
}
