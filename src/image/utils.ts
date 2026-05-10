import type { ImageCompressionOptions } from "./types";
import { HEIC_MIME_TYPES, HEIC_EXTENSIONS } from "./constants";

export function getBaseName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export function isHeicFile(file: File): boolean {
  if (HEIC_MIME_TYPES.includes(file.type as (typeof HEIC_MIME_TYPES)[number])) return true;
  const lower = file.name.toLowerCase();
  return HEIC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function computeOutputDimensions(
  srcW: number,
  srcH: number,
  options: ImageCompressionOptions,
): { w: number; h: number } {
  const { width, height, maxWidth, maxHeight } = options;

  if (width !== undefined && height !== undefined) return { w: width, h: height };
  if (width !== undefined) return { w: width, h: Math.round(srcH * (width / srcW)) };
  if (height !== undefined) return { w: Math.round(srcW * (height / srcH)), h: height };

  let ratio = 1;
  if (maxWidth !== undefined) ratio = Math.min(ratio, maxWidth / srcW);
  if (maxHeight !== undefined) ratio = Math.min(ratio, maxHeight / srcH);
  ratio = Math.min(ratio, 1); // never upscale

  return { w: Math.round(srcW * ratio), h: Math.round(srcH * ratio) };
}
