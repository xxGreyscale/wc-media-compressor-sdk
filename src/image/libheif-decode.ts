/**
 * libheif-js fallback path for HEIC/HEIF decoding.
 *
 * Used when `ImageDecoder` (WebCodecs) is unavailable or refuses the file —
 * notably Firefox, which has no WebCodecs implementation at all. The WASM
 * blob is lazy-loaded so non-Firefox users never download the ~1.4 MB bundle.
 *
 * libheif-js exposes the canonical libheif decoder API. The `wasm-bundle`
 * entry self-contains the WASM as base64, so no bundler-specific asset
 * handling is required from the consumer.
 */

type LibheifModule = typeof import("libheif-js/wasm-bundle").default;

let modulePromise: Promise<LibheifModule> | undefined;

function loadModule(): Promise<LibheifModule> {
  if (!modulePromise) {
    modulePromise = import("libheif-js/wasm-bundle").then((mod) => mod.default ?? mod);
  }
  return modulePromise;
}

/**
 * Decodes a HEIC/HEIF file to a canvas at its native dimensions.
 * The caller is responsible for any resizing.
 */
export async function decodeHeicToCanvas(file: File): Promise<HTMLCanvasElement> {
  const libheif = await loadModule();
  const buffer = await file.arrayBuffer();

  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buffer);
  if (!images || images.length === 0) {
    throw new Error("libheif: file contains no decodable images.");
  }

  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height) {
    throw new Error("libheif: decoded image has zero dimensions.");
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    image.display({ data: pixels, width, height }, (out: unknown) => {
      if (!out) reject(new Error("libheif: display callback returned null."));
      else resolve();
    });
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas;
}
