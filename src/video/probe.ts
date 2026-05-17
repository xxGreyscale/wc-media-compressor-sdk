import MP4Box from 'mp4box';
import type { VideoMetadata } from './types';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB

/**
 * Returns the input video's resolution, framerate, bitrate, duration, and
 * audio track info without doing a full demux. Useful for building
 * compression UIs that constrain user choices to values ≤ the source.
 *
 * Implementation note: this streams the file into mp4box.js and resolves the
 * moment `onReady` fires (i.e. after the `moov` box has been fully parsed).
 * For phone-default MP4s (`moov` at the start), that's typically within the
 * first chunk. For files with `moov` at the end, we still have to read most
 * of the file — but no samples are extracted, so memory stays low.
 */
export function probeVideo(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mp4file: any = MP4Box.createFile();
    let aborted = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mp4file.onReady = (info: any) => {
      if (aborted) return;
      aborted = true;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const video = info.tracks.find((t: any) => t.type === 'video');
      if (!video) {
        reject(new Error('No video track found in file.'));
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const audio = info.tracks.find((t: any) => t.type === 'audio');

      const durationSeconds = video.duration / video.timescale;
      const fps = video.nb_samples / Math.max(durationSeconds, 1e-9);

      resolve({
        width: video.video.width,
        height: video.video.height,
        fps,
        bitrate: Math.round((file.size * 8) / Math.max(durationSeconds, 1e-9)),
        durationSeconds,
        codec: video.codec,
        hasAudio: !!audio,
        ...(audio
          ? {
              audioCodec: audio.codec,
              audioSampleRate: audio.audio?.sample_rate,
              audioChannels: audio.audio?.channel_count,
            }
          : {}),
      });
    };

    mp4file.onError = (e: unknown) => {
      if (!aborted) reject(e instanceof Error ? e : new Error(String(e)));
    };

    const reader = new FileReader();
    let offset = 0;

    reader.onload = (e) => {
      if (aborted) return;
      const buf = e.target!.result as ArrayBuffer;
      (buf as ArrayBuffer & { fileStart: number }).fileStart = offset;
      offset += buf.byteLength;
      mp4file.appendBuffer(buf);
      if (aborted) return;
      if (offset < file.size) {
        reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
      } else {
        mp4file.flush();
        if (!aborted) {
          reject(new Error('Reached end of file before mp4box could parse the moov box.'));
        }
      }
    };

    reader.onerror = () => {
      if (!aborted) reject(reader.error);
    };

    reader.readAsArrayBuffer(file.slice(0, CHUNK_SIZE));
  });
}
