/**
 * Main-thread client for the libde265 HEVC decode Worker.
 *
 * Wraps the postMessage protocol behind a small async API:
 *   - `init(parameterSets)`     → resolves when the worker has parsed VPS/SPS/PPS
 *   - `feed(nals, pts)`         → fire-and-forget; decoded frames arrive via `setOnFrame`
 *   - `flush()`                 → resolves after the worker drains all remaining pictures
 *   - `close()`                 → terminates the worker
 *
 * The Worker URL is resolved at build time so the consumer's bundler
 * (Vite/webpack/Parcel) emits the worker as its own asset. Browsers without
 * native Worker module support fall back to a clear runtime error.
 */

export interface YuvFrameMessage {
  pts: bigint;
  width: number;
  height: number;
  /** I420-packed buffer: Y plane (w×h), then U (w/2 × h/2), then V (w/2 × h/2). */
  data: ArrayBuffer;
}

type WorkerMessage =
  | { type: "ready" }
  | { type: "done" }
  | { type: "error"; message: string }
  | ({ type: "frame" } & YuvFrameMessage);

export class HevcDecoderClient {
  private worker: Worker;
  private pendingResolve?: () => void;
  private pendingReject?: (err: Error) => void;
  private onFrame?: (frame: YuvFrameMessage) => void;

  constructor() {
    this.worker = new Worker(new URL("./hevc-decoder-worker.js", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
  }

  setOnFrame(cb: (frame: YuvFrameMessage) => void): void {
    this.onFrame = cb;
  }

  init(parameterSets: Uint8Array[]): Promise<void> {
    return this.awaitOnce(() =>
      this.worker.postMessage(
        { type: "init", parameterSets },
        parameterSets.map((p) => p.buffer),
      ),
    );
  }

  feed(nals: Uint8Array[], pts: bigint): void {
    this.worker.postMessage(
      { type: "sample", nals, pts },
      nals.map((n) => n.buffer),
    );
  }

  flush(): Promise<void> {
    return this.awaitOnce(() => this.worker.postMessage({ type: "flush" }));
  }

  close(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.terminate();
  }

  private awaitOnce(send: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      send();
    });
  }

  private handleMessage = (e: MessageEvent<WorkerMessage>): void => {
    const msg = e.data;
    if (msg.type === "frame") {
      this.onFrame?.(msg);
    } else if (msg.type === "ready" || msg.type === "done") {
      this.pendingResolve?.();
      this.pendingResolve = undefined;
      this.pendingReject = undefined;
    } else if (msg.type === "error") {
      this.pendingReject?.(new Error(msg.message));
      this.pendingResolve = undefined;
      this.pendingReject = undefined;
    }
  };

  private handleError = (e: ErrorEvent): void => {
    this.pendingReject?.(new Error(e.message || "HEVC decoder worker crashed."));
    this.pendingResolve = undefined;
    this.pendingReject = undefined;
  };
}
