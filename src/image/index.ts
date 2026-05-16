import type {
  ImageCompressionOptions,
  CompressedImageOutput,
  ImageOutputFormat,
  BatchImageCompressionItem,
  BatchImageCompressionResult,
} from "./types";
import {
  DEFAULT_IMAGE_OUTPUT_FORMATS,
  DEFAULT_IMAGE_PRESET,
  IMAGE_MIME_TYPES,
} from "./constants";
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
  ImageCompressionPreset,
} from "./types";

function resolveOptions(options?: ImageCompressionOptions): ImageCompressionOptions {
  return {
    outputFormats: DEFAULT_IMAGE_OUTPUT_FORMATS,
    preset: DEFAULT_IMAGE_PRESET,
    ...options,
  };
}

const MIME_TO_FORMAT: Record<string, ImageOutputFormat> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/webp": "webp",
  "image/png": "png",
};

/**
 * If our re-encoded output is no smaller than the original file, return the
 * original instead. Only applies when the output format matches the input
 * format (e.g. PNG → PNG) and the caller didn't ask for dimension changes —
 * in those cases the user's existing file is already better than anything we
 * can produce, and substituting avoids the "why is my compressed image
 * bigger" surprise.
 */
function applyInflationGuard(
  input: File,
  output: CompressedImageOutput,
  options: ImageCompressionOptions,
  outputFileName: string,
): CompressedImageOutput {
  const userScaled =
    options.maxWidth !== undefined ||
    options.maxHeight !== undefined ||
    options.width !== undefined ||
    options.height !== undefined;
  if (userScaled) return output;

  const inputFormat = MIME_TO_FORMAT[input.type];
  if (!inputFormat) return output;

  const slot = output[inputFormat];
  if (!slot || slot.size < input.size) return output;

  // Rebuild the file under the requested output name but with the original bytes.
  output[inputFormat] = new File([input], slot.name || `${outputFileName}.${inputFormat}`, {
    type: IMAGE_MIME_TYPES[inputFormat],
    lastModified: Date.now(),
  });
  return output;
}

/**
 * Compresses a single image file.
 *
 * - HEIC/HEIF (iPhone photos) are decoded with the WebCodecs `ImageDecoder` API
 *   — no WASM, no server round-trip.
 * - All other formats use the Canvas API (`createImageBitmap`).
 * - If Canvas cannot decode the file, `ImageDecoder` is tried as a fallback.
 * - If the compressed output is no smaller than the original AND the format
 *   matches the input AND the caller didn't request a resize, the original
 *   file is returned unchanged (under the configured output name).
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

  let result: CompressedImageOutput;
  if (isHeicFile(file)) {
    result = await compressWithImageDecoder(file, resolved, outputFileName, onProgress);
  } else {
    try {
      result = await compressWithCanvas(file, resolved, outputFileName, onProgress);
    } catch {
      // Canvas could not decode the file — try ImageDecoder as a fallback.
      result = await compressWithImageDecoder(file, resolved, outputFileName, onProgress);
    }
  }

  return applyInflationGuard(file, result, resolved, outputFileName);
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
