// Minimal type shim for libheif-js. The package ships no types and the API
// surface we use is small — a single decoder class with a handful of methods.

declare module "libheif-js/wasm-bundle" {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      callback: (out: unknown) => void,
    ): void;
  }

  interface HeifDecoder {
    decode(data: ArrayBuffer | Uint8Array): HeifImage[];
  }

  interface LibheifModule {
    HeifDecoder: new () => HeifDecoder;
  }

  const libheif: LibheifModule;
  export default libheif;
}
