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
import { compressWithLibheif } from "./libheif-compress";
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
 * If any of our re-encoded outputs ends up larger than the input, replace that
 * slot with the original file. The user's existing file is already better than
 * anything we can produce, and substituting avoids the "why is my compressed
 * image bigger" surprise.
 *
 * Only applies when the slot's format matches the input's format — otherwise
 * we'd hand back bytes that don't match the requested mime type / extension.
 * Format mismatches happen on the caller's terms (e.g. JPEG → PNG conversion),
 * so we leave those as-is even if they're larger.
 */
function applyInflationGuard(
  input: File,
  output: CompressedImageOutput,
  outputFileName: string,
): CompressedImageOutput {
  const inputFormat = MIME_TO_FORMAT[input.type];
  if (!inputFormat) return output;

  const slot = output[inputFormat];
  if (!slot || slot.size < input.size) return output;

  // Slot is ≥ input in the same format — substitute the original bytes under
  // the configured output filename and mime type.
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
 * - **Inflation guard**: when an output slot is in the same format as the input
 *   and ends up larger than the input, the slot is replaced with the original
 *   file's bytes under the configured output name. Cross-format outputs (e.g.
 *   JPEG → PNG conversion) are left as-is since substituting would mismatch
 *   the requested mime type.
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
    // Primary path: WebCodecs `ImageDecoder` (Chrome 94+, Safari 16.4+).
    // Fallback path: libheif-js WASM — covers Firefox and any browser whose
    // ImageDecoder doesn't recognise the specific HEIC variant.
    if ("ImageDecoder" in globalThis) {
      try {
        result = await compressWithImageDecoder(file, resolved, outputFileName, onProgress);
      } catch {
        result = await compressWithLibheif(file, resolved, outputFileName, onProgress);
      }
    } else {
      result = await compressWithLibheif(file, resolved, outputFileName, onProgress);
    }
  } else {
    try {
      result = await compressWithCanvas(file, resolved, outputFileName, onProgress);
    } catch {
      // Canvas could not decode the file — try ImageDecoder as a fallback.
      result = await compressWithImageDecoder(file, resolved, outputFileName, onProgress);
    }
  }

  return applyInflationGuard(file, result, outputFileName);
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
