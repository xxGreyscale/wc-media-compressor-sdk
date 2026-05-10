import type { ImageOutputFormat } from "./types";

export const DEFAULT_IMAGE_OUTPUT_FORMATS: ImageOutputFormat[] = ["webp"];
export const DEFAULT_IMAGE_QUALITY = 0.82;

export const IMAGE_MIME_TYPES: Record<ImageOutputFormat, string> = {
  jpeg: "image/jpeg",
  webp: "image/webp",
  png: "image/png",
} as const;

export const IMAGE_FORMAT_EXTENSIONS: Record<ImageOutputFormat, string> = {
  jpeg: "jpg",
  webp: "webp",
  png: "png",
} as const;

export const HEIC_MIME_TYPES = [
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
] as const;

export const HEIC_EXTENSIONS = [".heic", ".heif", ".heics", ".heix"] as const;

export const LOSSLESS_FORMATS: ImageOutputFormat[] = ["png"];

export const TARGET_SIZE_SEARCH_ITERATIONS = 10;
