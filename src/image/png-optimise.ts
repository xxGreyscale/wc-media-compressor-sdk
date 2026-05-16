/**
 * Lazy-loaded PNG optimiser backed by oxipng (compiled to WebAssembly).
 *
 * `canvas.toBlob('image/png')` uses libpng with default settings — no filter
 * optimisation, no palette quantisation, no zlib level tuning. Real-world PNGs
 * are typically post-processed by tools like oxipng/pngcrush, which routinely
 * shave 20–60% off what the browser produces.
 *
 * The WASM module is loaded on first use so consumers who never emit PNG
 * don't pay for it (single-thread build is ~160 KB gzipped).
 */

type OxipngModule = typeof import("@jsquash/oxipng");

let modulePromise: Promise<OxipngModule> | undefined;

function loadModule(): Promise<OxipngModule> {
  if (!modulePromise) {
    modulePromise = import("@jsquash/oxipng");
  }
  return modulePromise;
}

/**
 * Runs oxipng over a PNG blob and returns the (usually smaller) result.
 *
 * If anything goes wrong (oxipng fails to load, the input isn't a valid PNG,
 * the result is unexpectedly larger), the original blob is returned. This
 * function never throws — PNG output should always work.
 */
export async function optimisePng(blob: Blob): Promise<Blob> {
  try {
    const oxi = await loadModule();
    const input = await blob.arrayBuffer();
    const optimised = await oxi.optimise(input);
    if (!optimised || optimised.byteLength >= input.byteLength) {
      return blob;
    }
    return new Blob([optimised], { type: "image/png" });
  } catch {
    return blob;
  }
}
