import type { ImageCompressionOptions, CompressedImageOutput } from "./types";
import { computeOutputDimensions } from "./utils";
import { compressFromCanvas } from "./canvas-compress";

/**
 * Compresses an image using the WebCodecs ImageDecoder API.
 *
 * This is the primary path for HEIC/HEIF files (iPhone photos).
 * ImageDecoder handles formats that createImageBitmap cannot decode,
 * and runs natively in the browser without any WASM overhead.
 *
 * Browser support: Chrome 94+, Safari 16.4+. Firefox does not yet support ImageDecoder.
 *
 * @throws if ImageDecoder is unavailable or the file type is unsupported.
 */
export async function compressWithImageDecoder(
  file: File,
  options: ImageCompressionOptions,
  outputFileName: string,
  onProgress?: (progress: number) => void,
): Promise<CompressedImageOutput> {
  if (!("ImageDecoder" in globalThis)) {
    throw new Error(
      "ImageDecoder (WebCodecs) is not available in this browser. " +
      "HEIC files require Chrome 94+ or Safari 16.4+.",
    );
  }

  const type = file.type || "image/heic";
  const supported = await ImageDecoder.isTypeSupported(type);
  if (!supported) {
    throw new Error(`ImageDecoder does not support type "${type}" in this browser.`);
  }

  const decoder = new ImageDecoder({ data: file.stream(), type });
  let frame: VideoFrame | undefined;

  try {
    const result = await decoder.decode();
    frame = result.image;

    const srcW = frame.displayWidth;
    const srcH = frame.displayHeight;
    const { w, h } = computeOutputDimensions(srcW, srcH, options);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d", { alpha: false })!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(frame, 0, 0, w, h);

    return compressFromCanvas(canvas, options, outputFileName, onProgress);
  } finally {
    frame?.close();
    decoder.close();
  }
}
