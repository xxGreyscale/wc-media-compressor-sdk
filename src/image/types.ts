export type ImageOutputFormat = "jpeg" | "webp" | "png";

export interface ImageCompressionOptions {
  outputFileName?: string;
  outputFormats?: ImageOutputFormat[];
  /**
   * Image quality from 0 to 1. Applies to JPEG and WebP. Ignored for PNG.
   * @default 0.82
   */
  quality?: number;
  /**
   * Target output file size in KB per format.
   * Quality is automatically adjusted via binary search to fit. Ignored for PNG.
   */
  targetSizeKB?: number;
  maxWidth?: number;
  maxHeight?: number;
  width?: number;
  height?: number;
}

export interface CompressedImageOutput {
  [format: string]: File;
}

export interface BatchImageCompressionItem {
  file: File;
  options?: ImageCompressionOptions;
  onProgress?: (progress: number) => void;
}

export interface BatchImageCompressionResult {
  file: File;
  output?: CompressedImageOutput;
  error?: Error;
}
