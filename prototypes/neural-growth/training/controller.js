import { createTrainer } from "/trainer.js";
import { TextureNcaRuntime } from "/assets/js/models/neural-growth/runtime.js";
import { validateCheckpoint } from "/assets/js/models/neural-growth/reference.js";

const tf = window.tf;
await tf.setBackend("webgl");
await tf.ready();
const image = new Image();
image.src = "/target.png";
await image.decode();
const target = document.querySelector("#target");
target.getContext("2d").drawImage(image, 0, 0, 128, 128);
const id =
  new URLSearchParams(location.search).get("pattern") || "membrane-field";
const names = {
  "membrane-field": "Membrane Field",
  "filament-network": "Filament Network",
  "xeno-reef": "Xeno Reef",
};
if (!names[id]) throw new Error("Unknown training target.");
const spatial = new URLSearchParams(location.search).get("spatial") === "1";
const trainer = createTrainer(tf, target, { id, name: names[id], spatial });
const status = document.querySelector("#status");
window.patternTrainer = {
  trainer,
  running: false,
  error: null,
  records: [],
  async run(iterations = 1000) {
    if (this.running) throw new Error("Training is already running.");
    this.running = true;
    try {
      for (let index = 0; index < iterations && this.running; index += 1) {
        const started = performance.now();
        const record = await trainer.trainIteration();
        record.milliseconds = performance.now() - started;
        this.records.push(record);
        status.textContent = JSON.stringify(record);
        if (record.iteration % 50 === 0) await this.preview();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (error) {
      this.error = error.message;
      status.textContent = this.error;
      throw error;
    } finally {
      this.running = false;
    }
  },
  stop() {
    this.running = false;
  },
  async preview() {
    const { checkpoint } = await trainer.checkpoint();
    const runtime = new TextureNcaRuntime({
      model: validateCheckpoint(checkpoint),
      size: 128,
      seed: 17,
    });
    try {
      for (let index = 0; index < 4; index += 1) runtime.step(128);
      runtime.draw(document.querySelector("#preview"));
      return runtime.getStats();
    } finally {
      runtime.dispose();
    }
  },
};
status.textContent =
  "Ready — local WebGL training, from random initialization.";
