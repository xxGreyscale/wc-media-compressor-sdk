/**
 * PNG output via oxipng (WebAssembly).
 *
 * Two important details over a naive `canvas.toBlob('image/png')`:
 *
 *  1. **Raw-pixel path** — we feed `ImageData` straight to `optimise_raw`,
 *     skipping the browser's libpng encoder entirely. oxipng writes the PNG
 *     from scratch with optimal filter/depth/palette choices in one pass.
 *     The browser's PNG output is always PNG-32 (alpha channel even for
 *     opaque images) which then has to be reduced away — wasted work and
 *     often a missed palette conversion.
 *
 *  2. **`optimiseAlpha: true`** — strips the alpha channel when all pixels
 *     are opaque, which is the gate for PNG-8 palette-mode conversion.
 *     Without this flag oxipng leaves the canvas-produced alpha channel in
 *     place even when it's uniform 255, blocking palette reduction.
 *
 * Level 6 is the most aggressive oxipng setting — it exhaustively searches
 * filter combinations and runs every reduction strategy. Significantly
 * slower than the default (level 2), but the SDK is tuned for smallest
 * output, and "time the page is busy" is acceptable as a trade.
 *
 * The WASM module is loaded lazily — consumers who never emit PNG never pay.
 */

type OxipngModule = typeof import("@jsquash/oxipng");

let modulePromise: Promise<OxipngModule> | undefined;

function loadModule(): Promise<OxipngModule> {
  if (!modulePromise) modulePromise = import("@jsquash/oxipng");
  return modulePromise;
}

const OXIPNG_OPTIONS = { level: 6, interlace: false, optimiseAlpha: true } as const;

/**
 * Encodes a canvas to PNG via oxipng, writing the file directly from raw
 * pixel data. Falls back to a `canvas.toBlob` round-trip if oxipng fails
 * to load — PNG output should always work, even if it's larger.
 */
export async function encodePngFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  try {
    const oxi = await loadModule();
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas has no 2D context.");
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const bytes = await oxi.optimise(imgData, OXIPNG_OPTIONS);
    return new Blob([bytes], { type: "image/png" });
  } catch {
    return canvasToPngBlobFallback(canvas);
  }
}

function canvasToPngBlobFallback(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    );
  });
}
