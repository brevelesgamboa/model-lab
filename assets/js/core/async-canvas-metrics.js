const EMPTY = Object.freeze({
  signalMean: 0,
  signalDeviation: 0,
  entropy: 0,
  edgeDensity: 0,
  symmetryError: 0,
  chroma: 0,
  complexity: 0,
});

// Opt-in statistics for a GPU surface: snapshot asynchronously, then read pixels
// and calculate the same Workbench metrics away from the rendering thread.
export class AsyncCanvasMetrics {
  constructor(onUpdate = () => {}) {
    this.onUpdate = onUpdate;
    this.sequence = 0;
    this.reset();
  }
  reset() {
    this.worker?.terminate();
    this.worker = null;
    this.pending = null;
    this.value = EMPTY;
    this.fresh = true;
    this.failed = false;
  }
  read(canvas, refresh = false) {
    if ((refresh || this.fresh) && !this.pending && !this.failed)
      this.capture(canvas);
    return this.value;
  }
  async capture(canvas) {
    const id = ++this.sequence;
    this.pending = id;
    this.fresh = false;
    let bitmap;
    try {
      bitmap = await createImageBitmap(canvas, {
        resizeWidth: 96,
        resizeHeight: 96,
        resizeQuality: "low",
      });
      if (this.pending !== id) return;
      if (!this.worker) {
        const worker = new Worker(
          new URL("./canvas-metrics.worker.js", import.meta.url),
          { type: "module" },
        );
        this.worker = worker;
        worker.onmessage = ({ data }) => {
          if (this.worker !== worker || this.pending !== data.id) return;
          this.pending = null;
          this.value = Object.freeze(data.metrics);
          this.onUpdate();
        };
        worker.onerror = () => {
          if (this.worker === worker) {
            this.reset();
            this.failed = true;
          }
        };
      }
      this.worker.postMessage({ id, bitmap }, [bitmap]);
      bitmap = null;
    } catch {
      if (this.pending === id) {
        this.reset();
        this.failed = true;
      }
    } finally {
      bitmap?.close();
    }
  }
}
