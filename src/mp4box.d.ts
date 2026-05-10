declare module 'mp4box' {
  interface MP4MediaTrack {
    id: number;
    codec: string;
    type: string;
    timescale: number;
    duration: number;
    nb_samples: number;
    language: string;
  }

  interface MP4VideoTrack extends MP4MediaTrack {
    type: 'video';
    video: { width: number; height: number };
  }

  interface MP4AudioTrack extends MP4MediaTrack {
    type: 'audio';
    audio: { sample_rate: number; channel_count: number };
  }

  type MP4Track = MP4VideoTrack | MP4AudioTrack;

  interface MP4Info {
    duration: number;
    timescale: number;
    tracks: MP4Track[];
    videoTracks: MP4VideoTrack[];
    audioTracks: MP4AudioTrack[];
  }

  interface MP4Sample {
    data: ArrayBuffer;
    dts: number;
    cts: number;
    duration: number;
    timescale: number;
    is_sync: boolean;
  }

  interface ExtractionOptions {
    nbSamples?: number;
  }

  interface ISOFile {
    onReady: (info: MP4Info) => void;
    onSamples: (trackId: number, user: unknown, samples: MP4Sample[]) => void;
    onError: (e: unknown) => void;
    appendBuffer(buffer: ArrayBuffer): void;
    start(): void;
    flush(): void;
    setExtractionOptions(trackId: number, user: unknown, options: ExtractionOptions): void;
    getTrackById(id: number): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addTrack(options: Record<string, any>): number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addSample(trackId: number, data: ArrayBuffer, options: Record<string, any>): void;
    getBuffer(): ArrayBuffer;
    getInfo(): MP4Info;
  }

  const DataStream: new (buffer?: ArrayBuffer, offset?: number, endianness?: boolean) => {
    buffer: ArrayBuffer;
  } & { BIG_ENDIAN: boolean };

  function createFile(): ISOFile;

  export { createFile, DataStream, ISOFile, MP4Info, MP4Track, MP4Sample };
  export default { createFile, DataStream };
}
