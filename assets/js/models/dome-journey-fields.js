import { luminanceDepth, uploadDepthTexture } from "./depth-estimator.js";
import { uploadDream360 } from "./inception-dream-bake.js";
import { DREAM_REGIONS } from "./dome-journey.js";
import {
  dreamCellHash,
  dreamWarp,
  DREAM_CELL_SIZE,
} from "./dome-journey-layout.js";

// Owns real color/depth texture pairs. The Map bounds CPU backing stores too;
// evicted rooms can be generated again instead of growing an unbounded archive.
export class RoomTexturePool {
  constructor(capacity = 8) {
    this.capacity = Math.max(1, Math.min(8, capacity));
    this.entries = new Map();
    this.gl = null;
  }
  attach(gl) {
    if (this.gl === gl) return;
    this.releaseGPU();
    this.gl = gl;
  }
  get(key, touch = true) {
    const room = this.entries.get(key);
    if (room && touch) {
      this.entries.delete(key);
      this.entries.set(key, room);
    }
    return room;
  }
  put(key, room) {
    const previous = this.entries.get(key);
    if (previous) this.release(previous);
    this.entries.delete(key);
    this.entries.set(key, room);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      this.release(this.entries.get(oldest));
      this.entries.delete(oldest);
    }
    return room;
  }
  release(room, deleteTextures = true) {
    if (room.gpu && deleteTextures && this.gl)
      for (const texture of room.gpu) this.gl.deleteTexture(texture);
    room.gpu = null;
  }
  releaseGPU(deleteTextures = true) {
    for (const room of this.entries.values())
      this.release(room, deleteTextures);
    this.gl = null;
  }
  upload(room) {
    if (!this.gl || room.gpu) return room.gpu;
    const gl = this.gl,
      pair = [gl.createTexture(), gl.createTexture()];
    try {
      uploadDream360(gl, pair[0], room.image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      uploadDepthTexture(gl, pair[1], room.depth);
      room.gpu = pair;
      return pair;
    } catch (error) {
      for (const texture of pair) gl.deleteTexture(texture);
      throw error;
    }
  }
  clear() {
    for (const room of this.entries.values()) this.release(room);
    this.entries.clear();
  }
}

export function frontierEntryEdge(from, to) {
  const dx = to[0] - from[0],
    dz = to[1] - from[1];
  return Math.abs(dx) > Math.abs(dz)
    ? dx > 0
      ? "left"
      : "right"
    : dz > 0
      ? "top"
      : "bottom";
}
const cosineKeep = (distance, span) =>
  0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, distance / span)));
export function cosineBorderKeep(x, y, width, height, entry) {
  const distances = {
    left: x / width,
    right: (width - 1 - x) / width,
    top: y / height,
    bottom: (height - 1 - y) / height,
  };
  let keep = 0;
  for (const [edge, d] of Object.entries(distances)) {
    const span = edge === entry ? 0.24 : 0.08;
    keep = Math.max(keep, cosineKeep(d, span));
  }
  return keep;
}
export function featherFrontierRoom(image, source, entry) {
  const ctx = image.getContext("2d"),
    { width, height } = image,
    frame = ctx.getImageData(0, 0, width, height),
    original = source.getContext("2d").getImageData(0, 0, width, height).data;
  const horizontal = Float32Array.from({ length: width }, (_, x) =>
    Math.max(
      cosineKeep(x / width, entry === "left" ? 0.24 : 0.08),
      cosineKeep((width - 1 - x) / width, entry === "right" ? 0.24 : 0.08),
    ),
  );
  const vertical = Float32Array.from({ length: height }, (_, y) =>
    Math.max(
      cosineKeep(y / height, entry === "top" ? 0.24 : 0.08),
      cosineKeep((height - 1 - y) / height, entry === "bottom" ? 0.24 : 0.08),
    ),
  );
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const keep = Math.max(horizontal[x], vertical[y]),
        i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        frame.data[i + c] =
          frame.data[i + c] * (1 - keep) + original[i + c] * keep;
    }
  ctx.putImageData(frame, 0, 0);
  return image;
}

export function prepareDreamRegion(source, region, width = 512, height = 256) {
  const canvas = new OffscreenCanvas(width, height),
    ctx = canvas.getContext("2d");
  const dx = Math.round((region.shift[0] * width) / 512),
    dy = Math.round((region.shift[1] * height) / 256);
  // Initialize missing pixels from the photo too; only the mask grants the
  // model permission to replace them. Every known pixel remains protected.
  ctx.drawImage(source, 0, 0, width, height);
  ctx.drawImage(source, dx, dy, width, height);
  const known = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (x >= dx && x < dx + width && y >= dy && y < dy + height)
        known[y * width + x] = 255;
  return { canvas, known };
}
function resultCanvas(result) {
  const canvas = new OffscreenCanvas(result.width, result.height);
  canvas
    .getContext("2d")
    .putImageData(
      new ImageData(result.rgba, result.width, result.height),
      0,
      0,
    );
  return canvas;
}
function restoreKnown(canvas, original, known) {
  const { width, height } = canvas,
    ctx = canvas.getContext("2d");
  const result = ctx.getImageData(0, 0, width, height),
    source = original.getContext("2d").getImageData(0, 0, width, height).data;
  for (let i = 0; i < known.length; i++)
    if (known[i]) result.data.set(source.subarray(i * 4, i * 4 + 4), i * 4);
  ctx.putImageData(result, 0, 0);
  return canvas;
}
const INITIAL_STATUS =
  "Explore the photo or click a radar frontier to generate its room during warp. Late fills are saved for a return visit.";

// Manual regional fills and autonomous warp fills have separate worker owners.
export class DomeJourneyFields {
  constructor({
    inpainter,
    baker,
    depthEstimator = null,
    onChange = () => {},
    onCommit = () => {},
    prepare = prepareDreamRegion,
    fromResult = resultCanvas,
    restore = restoreKnown,
    fallbackDepth = luminanceDepth,
    createFrontierWorkers = null,
    feather = featherFrontierRoom,
  }) {
    Object.assign(this, {
      inpainter,
      baker,
      depthEstimator,
      onChange,
      onCommit,
      prepare,
      fromResult,
      restore,
      fallbackDepth,
      createFrontierWorkers,
      feather,
    });
    this.revision = 0;
    this.images = [];
    this.depthMaps = [];
    this.metrics = [];
    this.state = "idle";
    this.progress = 0;
    this.status = INITIAL_STATUS;
    this.anchors = [];
    this.anchorDepths = [];
    this.pool = new RoomTexturePool();
    this.frontier = null;
    this.textureRevision = 0;
  }
  cancel(notify = true) {
    this.revision++;
    this.abort?.abort();
    this.abort = null;
    this.inpainter?.cancel();
    this.baker?.cancel();
    this.depthEstimator?.cancel();
    this.cancelFrontier();
    if (this.state === "baking") {
      this.state = this.images.length ? "ready" : "idle";
      this.status = "Generation cancelled · previous areas preserved.";
    }
    if (notify) this.onChange();
  }
  reset(notify = true) {
    this.cancel(false);
    this.images = [];
    this.depthMaps = [];
    this.metrics = [];
    this.pool.clear();
    this.textureRevision++;
    this.state = "idle";
    this.progress = 0;
    this.status = INITIAL_STATUS;
    if (notify) this.onCommit();
  }
  setAnchors(anchors) {
    this.reset(false);
    this.anchors = anchors;
    this.anchorDepths = anchors.map((image) => this.fallbackDepth(image));
    this.onCommit();
  }
  regionalImage(index) {
    return this.images[index] ?? this.anchors[index % 2 ? 2 : 1];
  }
  regionalDepth(index) {
    return this.depthMaps[index] ?? this.anchorDepths[index % 2 ? 2 : 1];
  }
  anchorFor(cell, seed) {
    const motif = dreamCellHash(...cell, seed) % 4;
    return this.anchors[motif === 0 ? 0 : motif === 3 ? 2 : 1];
  }
  cancelFrontier() {
    const job = this.frontier;
    if (!job) return;
    this.frontier = null;
    job.abort.abort();
    job.workers?.inpainter?.cancel();
    job.workers?.baker?.dispose();
    job.workers?.depthEstimator?.dispose();
    if (!job.result)
      this.status = "Room generation cancelled · image-seeded space preserved.";
  }
  async generateFrontierNode(id, cell, anchorImage, options = {}) {
    this.cancelFrontier();
    if (
      id === "0,0" ||
      this.pool.get(id) ||
      !anchorImage ||
      !this.createFrontierWorkers
    )
      return null;
    const job = {
      id,
      cell: [...cell],
      abort: new AbortController(),
      arrived: false,
      result: null,
    };
    this.frontier = job;
    const signal = job.abort.signal,
      stale = () => signal.aborted || this.frontier !== job;
    let releaseAbort;
    try {
      const workers = (job.workers = this.createFrontierWorkers());
      releaseAbort = () => {
        workers.inpainter?.cancel();
        workers.baker?.dispose();
        workers.depthEstimator?.dispose();
      };
      signal.addEventListener("abort", releaseAbort, { once: true });
      const hash = dreamCellHash(...cell, options.seed || 0),
        edge = frontierEntryEdge(options.from || [0, 0], options.to || cell),
        amount = 120 + (hash % 57),
        shift =
          edge === "left"
            ? [amount, 0]
            : edge === "right"
              ? [-amount, 0]
              : edge === "top"
                ? [0, amount / 2]
                : [0, -amount / 2],
        seed = this.prepare(anchorImage, { id, shift });
      this.status = "Warp · generating the next room locally…";
      this.onChange();
      let image, generator;
      try {
        const ready = await workers.inpainter.prepare();
        if (stale()) return null;
        if (ready.type === "missing") throw new Error("MI-GAN unavailable");
        image = await workers.inpainter.inpaintMasked(seed.canvas, seed.known, {
          signal,
        });
        generator = "MI-GAN";
      } catch (error) {
        if (stale() || error.name === "AbortError") return null;
        workers.inpainter?.cancel();
        if (!workers.baker) throw error;
        const result = await workers.baker.bake(
          seed.canvas,
          options.layer || "mixed_5b",
          options.channel ?? 120,
          4,
          {
            signal,
            photoRect: null,
            preserveDetail: true,
            stepSize: 0.008,
            colorRetention: options.colorRetention ?? 1,
          },
        );
        if (stale()) return null;
        image = this.restore(this.fromResult(result), seed.canvas, seed.known);
        generator = "Inception";
      }
      if (stale()) return null;
      workers.inpainter?.cancel();
      workers.baker?.dispose();
      image = this.feather(image, seed.canvas, edge);
      let depth;
      try {
        depth = {
          ...(await workers.depthEstimator.estimate(image, { signal })),
          kind: "estimated",
        };
      } catch (error) {
        if (stale()) return null;
        depth = {
          ...this.fallbackDepth(image),
          error: error.message,
          kind: "luminance",
        };
      }
      if (stale()) return null;
      job.result = {
        cell: [...cell],
        image,
        depth,
        generator,
        deferred: job.arrived,
      };
      // Early results wait for arrival. Late results are cached for the next
      // visit, keeping the current room's projection stable after the blossom.
      if (job.arrived) {
        this.pool.put(id, job.result);
        this.textureRevision++;
        this.status = "Room generated · ready for your next visit.";
      } else this.status = "Room and depth ready · arriving…";
      this.onChange();
      return job.result;
    } catch (error) {
      if (!stale()) {
        job.error = error.message;
        this.status = `Image-seeded room · local generation unavailable: ${error.message}`;
        this.onChange();
      }
      return null;
    } finally {
      signal.removeEventListener("abort", releaseAbort);
      releaseAbort?.();
    }
  }
  completeFrontier(id) {
    const cached = this.pool.get(id);
    if (cached) {
      cached.deferred = false;
      this.textureRevision++;
      return;
    }
    const job = this.frontier;
    if (!job || job.id !== id || job.abort.signal.aborted) return;
    job.arrived = true;
    if (job.result) {
      this.pool.put(id, job.result);
      this.textureRevision++;
      this.onCommit();
      this.status = `Room ready · ${job.result.generator} + ${job.result.depth.kind === "estimated" ? "Depth Anything" : "brightness relief"}`;
    } else
      this.status = job.error
        ? `Image-seeded room · local generation unavailable: ${job.error}`
        : "Image-seeded room · still generating locally for your next visit…";
    this.onChange();
  }
  roomBindings(position, seed, gl) {
    this.pool.attach(gl);
    const cell = dreamWarp(position, seed).map((v) =>
      Math.round(v / DREAM_CELL_SIZE),
    );
    const key = cell.join(",");
    for (const [id, room] of this.pool.entries)
      if (room.deferred && id !== key) room.departed = true;
    const current = this.pool.get(key);
    if (current?.deferred && current.departed) {
      current.deferred = false;
      this.textureRevision++;
    }
    const base = dreamWarp(position, seed).map((v) =>
      Math.floor(v / DREAM_CELL_SIZE),
    );
    return Array.from({ length: 4 }, (_, i) => {
      const coords = [base[0] + (i % 2), base[1] + Math.floor(i / 2)],
        room = this.pool.get(coords.join(","), false);
      if (room && !room.deferred) {
        this.pool.upload(room);
        return room;
      }
      const motif = dreamCellHash(...coords, seed) % 4,
        anchor = motif === 0 ? 0 : motif === 3 ? 2 : 1;
      return {
        cell: coords,
        motif,
        photoIndex: this.images.length ? 4 + motif : 3 + anchor,
        depthIndex: this.images.length
          ? 8 + motif
          : anchor === 0
            ? 1
            : 7 + anchor,
      };
    });
  }
  async generate(
    source,
    layer,
    channel,
    colorRetention = 1,
    { neuralDetail = false, regions = DREAM_REGIONS.slice(1) } = {},
  ) {
    this.cancel(false);
    const revision = this.revision,
      abort = new AbortController();
    this.abort = abort;
    this.state = "baking";
    this.progress = 0;
    this.status = "Preparing local MI-GAN…";
    this.onChange();
    const images = [],
      depthMaps = [],
      metrics = [];
    const stale = () => revision !== this.revision || abort.signal.aborted;
    try {
      const ready = await this.inpainter.prepare();
      if (stale()) return false;
      if (ready.type === "missing") {
        this.state = "missing";
        this.status =
          "MI-GAN is needed for regional fills. Choose its model under Outpainting mode, then retry. The photo passages remain explorable.";
        return false;
      }
      for (const [index, region] of regions.entries()) {
        if (stale()) return false;
        const seed = this.prepare(
            this.anchors[index % 2 ? 2 : 1] ?? source,
            region,
          ),
          started = performance.now();
        this.status = `Extending ${region.name} with MI-GAN (${index + 1}/4)…`;
        this.onChange();
        let canvas = await this.inpainter.inpaintMasked(
          seed.canvas,
          seed.known,
        );
        if (stale()) return false;
        let refinement = null;
        if (neuralDetail) {
          this.status = `Adding optional neuron detail to ${region.name}…`;
          this.onChange();
          const result = await this.baker.bake(canvas, layer, channel, 4, {
            photoRect: null,
            stepSize: 0.008,
            preserveDetail: true,
            colorRetention,
            signal: abort.signal,
          });
          if (stale()) return false;
          canvas = this.restore(
            this.fromResult(result),
            seed.canvas,
            seed.known,
          );
          const { rgba: _rgba, ...stats } = result;
          refinement = stats;
        }
        images.push(canvas);
        metrics.push({
          region: region.id,
          generator: "MI-GAN",
          knownFraction:
            seed.known.reduce((sum, v) => sum + Number(v > 0), 0) /
            seed.known.length,
          fillMs: performance.now() - started,
          refinement,
        });
        this.progress = Math.round(
          ((index + 1) / regions.length) * (this.depthEstimator ? 70 : 100),
        );
        this.onChange();
      }
      this.inpainter.cancel();
      this.baker?.dispose();
      if (this.depthEstimator)
        for (const [index, image] of images.entries()) {
          this.status = `Shaping ${regions[index].name} with Depth Anything…`;
          this.onChange();
          let depth;
          try {
            depth = {
              ...(await this.depthEstimator.estimate(image, {
                signal: abort.signal,
              })),
              kind: "estimated",
            };
          } catch (error) {
            if (stale()) return false;
            depth = {
              ...this.fallbackDepth(image),
              kind: "luminance",
              error: error.message,
            };
          }
          if (stale()) return false;
          depthMaps.push(depth);
          this.progress = Math.round(70 + ((index + 1) / regions.length) * 30);
          this.onChange();
        }
      if (stale()) return false;
      this.images = images;
      this.depthMaps = depthMaps;
      this.metrics = metrics;
      this.state = "ready";
      this.progress = 100;
      const fallback = depthMaps.filter((d) => d.kind !== "estimated").length;
      this.status = `Four photo-based areas ready · MI-GAN fills cached${fallback ? ` · ${fallback} using brightness relief` : ""}. Explore freely; returning to the source restores your photo.`;
      this.onCommit();
      return true;
    } catch (error) {
      if (stale()) return false;
      this.state = "error";
      this.status = `Could not extend the space · ${error.message}. Previous areas preserved.`;
      return false;
    } finally {
      if (revision === this.revision) {
        this.abort = null;
        this.inpainter?.cancel();
        this.baker?.dispose();
        this.depthEstimator?.dispose();
        this.onChange();
      }
    }
  }
}
