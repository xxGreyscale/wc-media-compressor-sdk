export interface VideoCompressionOptions {
  /** Target video bitrate in bits/second. */
  targetBitrate: number;
  /** Optional max width — height is derived to keep aspect ratio. */
  maxWidth?: number;
}

export interface VideoCompressionResult {
  blob: Blob;
  originalBytes: number;
  compressedBytes: number;
  durationMs: number;
}

export type VideoCompressionPhase = 'decode' | 'encode' | 'mux';

export type VideoCompressionProgressCallback = (phase: VideoCompressionPhase, percent: number) => void;

/** A raw sample as extracted by mp4box. */
export interface RawSample {
  data: ArrayBuffer;
  dts: number;
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
}

export interface VideoTrackInfo {
  id: number;
  codec: string;
  timescale: number;
  duration: number;
  width: number;
  height: number;
  /** AVCDecoderConfigurationRecord — needed by VideoDecoder. */
  description: Uint8Array | undefined;
  samples: RawSample[];
  fps: number;
}

export interface AudioTrackInfo {
  id: number;
  codec: string;
  timescale: number;
  duration: number;
  sampleRate: number;
  channelCount: number;
  samples: RawSample[];
}

export interface DemuxResult {
  video: VideoTrackInfo;
  audio: AudioTrackInfo | null;
  /** Reference to the live mp4box ISOFile — needed to copy the audio esds box at mux time. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mp4boxFile: any;
}

export interface EncodedVideoChunk_ {
  chunk: EncodedVideoChunk;
  isKey: boolean;
}
