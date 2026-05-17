// Video compression
export { compressVideo, probeVideo } from './video/index';
export type {
  VideoCompressionOptions,
  VideoCompressionResult,
  VideoCompressionProgressCallback,
  VideoMetadata,
} from './video/types';

// Thumbnail extraction
export { extractThumbnail } from './thumbnail/index';
export type {
  ThumbnailResult,
  ThumbnailQuality,
  ThumbnailConfig,
  ThumbnailOptions,
} from './thumbnail/types';

// Image compression
export { compressImage, compressImages } from './image/index';
export type {
  ImageCompressionOptions,
  ImageCompressionPreset,
  CompressedImageOutput,
  ImageOutputFormat,
  BatchImageCompressionItem,
  BatchImageCompressionResult,
} from './image/types';
