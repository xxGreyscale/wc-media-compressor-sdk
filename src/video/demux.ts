import MP4Box from 'mp4box';
import type { DemuxResult, RawSample, VideoTrackInfo, AudioTrackInfo } from './types';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB

export function demux(file: File): Promise<DemuxResult> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mp4file: any = MP4Box.createFile();

    let videoTrack: VideoTrackInfo | null = null;
    let audioTrack: AudioTrackInfo | null = null;
    let totalSamples = 0;
    let receivedSamples = 0;
    let allTracksReady = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mp4file.onReady = (info: any) => {
      for (const track of info.tracks) {
        if (track.type === 'video' && !videoTrack) {
          videoTrack = {
            id: track.id,
            codec: track.codec,
            timescale: track.timescale,
            duration: track.duration,
            width: track.video.width,
            height: track.video.height,
            description: extractVideoDescription(mp4file, track.id),
            samples: [],
            fps: track.nb_samples / (track.duration / track.timescale),
          };
        } else if (track.type === 'audio' && !audioTrack) {
          audioTrack = {
            id: track.id,
            codec: track.codec,
            timescale: track.timescale,
            duration: track.duration,
            sampleRate: track.audio.sample_rate,
            channelCount: track.audio.channel_count,
            samples: [],
          };
        }

        totalSamples += track.nb_samples;
        mp4file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      }

      if (!videoTrack) {
        reject(new Error('No video track found in file.'));
        return;
      }

      allTracksReady = true;
      mp4file.start();
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mp4file.onSamples = (trackId: number, _user: unknown, samples: any[]) => {
      const target = videoTrack?.id === trackId
        ? videoTrack
        : audioTrack?.id === trackId
          ? audioTrack
          : null;

      if (target) {
        for (const s of samples) {
          const sample: RawSample = {
            data: s.data,
            dts: s.dts,
            cts: s.cts,
            duration: s.duration,
            timescale: s.timescale,
            is_sync: s.is_sync,
          };
          target.samples.push(sample);
          receivedSamples++;
        }
      }

      if (allTracksReady && receivedSamples >= totalSamples) {
        resolve({ video: videoTrack!, audio: audioTrack, mp4boxFile: mp4file });
      }
    };

    mp4file.onError = reject;

    // Stream the file into mp4box in chunks
    const reader = new FileReader();
    let offset = 0;

    function readNext() {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    }

    reader.onload = (e) => {
      const buf = e.target!.result as ArrayBuffer;
      // mp4box requires a fileStart property on the ArrayBuffer
      (buf as ArrayBuffer & { fileStart: number }).fileStart = offset;
      offset += buf.byteLength;
      mp4file.appendBuffer(buf);
      if (offset < file.size) {
        readNext();
      } else {
        mp4file.flush();
      }
    };

    reader.onerror = () => reject(reader.error);
    readNext();
  });
}

/**
 * Extracts the decoder configuration record for the video track. Handles both
 * AVCDecoderConfigurationRecord (H.264 `avcC` box) and HEVCDecoderConfigurationRecord
 * (`hvcC` / `hev1C` for HEVC). Returned without the 8-byte box header.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractVideoDescription(mp4file: any, trackId: number): Uint8Array | undefined {
  try {
    const trak = mp4file.getTrackById(trackId);
    const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    const configBox = entry?.avcC ?? entry?.hvcC ?? entry?.hev1C;
    if (!configBox) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = new (MP4Box as any).DataStream(undefined, 0, (MP4Box as any).DataStream.BIG_ENDIAN);
    configBox.write(stream);
    return new Uint8Array(stream.buffer, 8);
  } catch {
    return undefined;
  }
}
