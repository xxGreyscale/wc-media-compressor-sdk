import type { ImageCompressionOptions, CompressedImageOutput } from "./types";
import { computeOutputDimensions } from "./utils";
import { compressFromCanvas } from "./canvas-compress";
import { decodeHeicToCanvas } from "./libheif-decode";

/**
 * Fallback HEIC compression path using the libheif WASM decoder.
 *
 * Used when the WebCodecs `ImageDecoder` API is unavailable (Firefox) or
 * cannot handle the specific HEIC variant. Otherwise indistinguishable from
 * the primary `compressWithImageDecoder` path — both produce a canvas which
 * is then handed to `compressFromCanvas`.
 */
export async function compressWithLibheif(
  file: File,
  options: ImageCompressionOptions,
  outputFileName: string,
  onProgress?: (progress: number) => void,
): Promise<CompressedImageOutput> {
  const sourceCanvas = await decodeHeicToCanvas(file);
  const { w, h } = computeOutputDimensions(sourceCanvas.width, sourceCanvas.height, options);

  let outputCanvas: HTMLCanvasElement;
  if (w === sourceCanvas.width && h === sourceCanvas.height) {
    outputCanvas = sourceCanvas;
  } else {
    outputCanvas = document.createElement("canvas");
    outputCanvas.width = w;
    outputCanvas.height = h;
    outputCanvas.getContext("2d")!.drawImage(sourceCanvas, 0, 0, w, h);
    sourceCanvas.width = 0;
    sourceCanvas.height = 0;
  }

  try {
    return await compressFromCanvas(outputCanvas, options, outputFileName, onProgress);
  } finally {
    outputCanvas.width = 0;
    outputCanvas.height = 0;
  }
}
