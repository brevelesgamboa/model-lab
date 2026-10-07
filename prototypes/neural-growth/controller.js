import { TextureNcaRuntime } from "./runtime.js";
import { validateCheckpoint } from "./reference.js";

const elements = {
  canvas: document.getElementById("growth-canvas"),
  viewport: document.querySelector(".canvas-container"),
  play: document.getElementById("play-toggle"),
  step: document.getElementById("single-step"),
  restart: document.getElementById("restart"),
  disturb: document.getElementById("disturb"),
  snapshot: document.getElementById("snapshot"),
  settings: document.getElementById("settings"),
  seed: document.getElementById("seed"),
  size: document.getElementById("grid-size"),
  speed: document.getElementById("growth-speed"),
  speedValue: document.getElementById("speed-value"),
  palette: document.getElementById("palette"),
  runState: document.getElementById("run-state"),
  gridStatus: document.getElementById("grid-status"),
  stepStatus: document.getElementById("step-status"),
  backendStatus: document.getElementById("backend-status"),
  error: document.getElementById("load-error"),
};

const parameters = { seed: 1, size: 128, speed: 30, palette: "native" };
const fetchControllers = new Set();
const downloadUrls = new Set();
let runtime = null;
let checkpoint = null;
let checkpointPromise = null;
let playing = true;
let loading = false;
let disposed = false;
let pageSuspended = false;
let loadEpoch = 0;
let frameRequest = null;
let lastTimestamp = null;
let accumulator = 0;
let lastMetricsTimestamp = 0;
let pointerId = null;
let errorMessage = "";

function resetTiming() {
  if (frameRequest !== null) cancelAnimationFrame(frameRequest);
  frameRequest = null;
  lastTimestamp = null;
  accumulator = 0;
}

function canAnimate() {
  return Boolean(
    runtime &&
    playing &&
    !loading &&
    !disposed &&
    !pageSuspended &&
    !document.hidden &&
    parameters.speed > 0,
  );
}

function scheduleFrame() {
  if (canAnimate() && frameRequest === null)
    frameRequest = requestAnimationFrame(animate);
}

function displayError(error) {
  errorMessage = error instanceof Error ? error.message : String(error);
  elements.error.textContent = errorMessage;
  elements.error.hidden = false;
}

function clearError() {
  errorMessage = "";
  elements.error.textContent = "";
  elements.error.hidden = true;
}

function updateMetrics() {
  if (!runtime) return;
  const stats = runtime.getStats();
  elements.stepStatus.textContent = `${stats.steps.toLocaleString()} updates`;
  elements.gridStatus.textContent = `${stats.size} × ${stats.size} cells`;
  elements.backendStatus.textContent = `${stats.backend}${stats.renderer ? ` · ${stats.renderer}` : ""}`;
}

function updateControls() {
  const ready = Boolean(runtime && !disposed && !pageSuspended);
  elements.settings.disabled = !ready || loading;
  for (const button of [
    elements.play,
    elements.step,
    elements.disturb,
    elements.snapshot,
  ])
    button.disabled = !ready || loading;
  // A failed first load remains retryable; a failed replacement keeps the old state.
  elements.restart.disabled = loading || disposed || pageSuspended;
  elements.restart.textContent = ready ? "Restart" : "Retry load";
  elements.play.textContent = playing ? "Pause" : "Play";
  elements.play.setAttribute("aria-pressed", String(playing));
  elements.speedValue.textContent = `${parameters.speed} updates/s`;
  elements.runState.textContent = pageSuspended
    ? "Paused · page suspended"
    : loading
      ? "Loading checkpoint"
      : !ready
        ? "Checkpoint unavailable"
        : document.hidden
          ? "Paused · hidden tab"
          : !playing || parameters.speed === 0
            ? "Paused"
            : "Running";
  updateMetrics();
}

function draw() {
  if (runtime) runtime.draw(elements.canvas, parameters.palette);
}

function animate(timestamp) {
  frameRequest = null;
  if (!canAnimate()) {
    resetTiming();
    return;
  }
  const delta =
    lastTimestamp === null
      ? 0
      : Math.min(0.05, Math.max(0, (timestamp - lastTimestamp) / 1000));
  lastTimestamp = timestamp;
  // Drop excess work instead of allowing a delayed frame to create a catch-up burst.
  accumulator = Math.min(2, accumulator + delta * parameters.speed);
  const steps = Math.floor(accumulator);
  try {
    if (steps > 0) {
      runtime.step(steps);
      accumulator -= steps;
      draw();
    }
    if (timestamp - lastMetricsTimestamp >= 500) {
      updateMetrics();
      lastMetricsTimestamp = timestamp;
    }
  } catch (error) {
    playing = false;
    resetTiming();
    displayError(error);
    updateControls();
    return;
  }
  scheduleFrame();
}

async function fetchCheckpoint() {
  const controller = new AbortController();
  fetchControllers.add(controller);
  try {
    const response = await fetch(
      new URL("./checkpoint.json", import.meta.url),
      {
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok)
      throw new Error(`Checkpoint request failed (${response.status}).`);
    return validateCheckpoint(await response.json());
  } finally {
    fetchControllers.delete(controller);
  }
}

async function replaceRuntime({
  size = parameters.size,
  seed = parameters.seed,
  reload = false,
} = {}) {
  if (disposed || pageSuspended) return false;
  const epoch = ++loadEpoch;
  let candidate = null;
  resetTiming();
  loading = true;
  clearError();
  updateControls();
  try {
    let model = checkpoint;
    if (reload) model = await fetchCheckpoint();
    else if (!model) {
      if (!checkpointPromise) {
        const promise = fetchCheckpoint().catch((error) => {
          if (checkpointPromise === promise) checkpointPromise = null;
          throw error;
        });
        checkpointPromise = promise;
      }
      model = await checkpointPromise;
    }
    if (disposed || epoch !== loadEpoch) return false;
    candidate = new TextureNcaRuntime({ model, size, seed });
    // Validate rendering off-screen before replacing either the state or visible frame.
    const preview = document.createElement("canvas");
    preview.width = elements.canvas.width;
    preview.height = elements.canvas.height;
    candidate.draw(preview, parameters.palette);
    if (disposed || epoch !== loadEpoch) return false;
    const previous = runtime;
    runtime = candidate;
    candidate = null;
    checkpoint = model;
    parameters.size = size;
    parameters.seed = seed;
    elements.size.value = String(size);
    elements.seed.value = String(seed);
    elements.canvas.getContext("2d").drawImage(preview, 0, 0);
    previous?.dispose();
    lastMetricsTimestamp = 0;
    return true;
  } catch (error) {
    if (!disposed && epoch === loadEpoch) {
      displayError(error);
      elements.size.value = String(parameters.size);
      elements.seed.value = String(parameters.seed);
    }
    return false;
  } finally {
    candidate?.dispose();
    if (!disposed && epoch === loadEpoch) {
      loading = false;
      updateControls();
      scheduleFrame();
    }
  }
}

function requireRuntime() {
  if (!runtime || loading || disposed || pageSuspended)
    throw new Error("The simulation is not ready.");
  return runtime;
}

function validSeed(value) {
  if (typeof value === "string" && value.trim() === "")
    throw new Error("Seed must be an integer from 0 to 4294967295.");
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("Seed must be an integer from 0 to 4294967295.");
  return seed;
}

function play() {
  if (disposed) return;
  playing = true;
  resetTiming();
  updateControls();
  scheduleFrame();
}

function pause() {
  playing = false;
  resetTiming();
  updateControls();
}

function singleStep() {
  const current = requireRuntime();
  pause();
  current.step(1);
  draw();
  updateMetrics();
}

function restart(seed = parameters.seed) {
  const nextSeed = validSeed(seed);
  if (!runtime) return replaceRuntime({ seed: nextSeed });
  requireRuntime();
  resetTiming();
  runtime.restart(nextSeed);
  parameters.seed = nextSeed;
  elements.seed.value = String(nextSeed);
  clearError();
  draw();
  updateControls();
  scheduleFrame();
  return true;
}

function setSeed(value) {
  const seed = validSeed(value);
  if (seed === parameters.seed && runtime) return true;
  return restart(seed);
}

function setSize(value) {
  const size = Number(value);
  if (![128, 256].includes(size))
    throw new Error("The simulation grid must be 128 or 256 cells wide.");
  if (size === parameters.size && runtime && !loading)
    return Promise.resolve(true);
  return replaceRuntime({ size });
}

function setSpeed(value) {
  const speed = Number(value);
  if (!Number.isInteger(speed) || speed < 0 || speed > 120)
    throw new Error("Growth speed must be an integer from 0 to 120 updates/s.");
  parameters.speed = speed;
  elements.speed.value = String(speed);
  resetTiming();
  updateControls();
  scheduleFrame();
}

function setPalette(value) {
  if (!["native", "spectral"].includes(value))
    throw new Error("Unknown display palette.");
  parameters.palette = value;
  elements.palette.value = value;
  draw();
}

function disturb(
  x = Math.floor(parameters.size / 2),
  y = Math.floor(parameters.size / 2),
  radius = Math.max(2, Math.floor(parameters.size * 0.07)),
) {
  const current = requireRuntime();
  if (![x, y, radius].every(Number.isFinite) || radius <= 0)
    throw new Error(
      "Disturbance coordinates and radius must be finite; radius must be positive.",
    );
  current.disturb(Math.floor(x), Math.floor(y), radius);
  draw();
  updateMetrics();
}

async function snapshot() {
  const current = requireRuntime();
  const image = document.createElement("canvas");
  image.width = elements.canvas.width;
  image.height = elements.canvas.height;
  current.draw(image, parameters.palette);
  return new Promise((resolve, reject) =>
    image.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG snapshot could not be encoded."));
    }, "image/png"),
  );
}

async function downloadSnapshot() {
  const blob = await snapshot();
  if (disposed) return;
  const url = URL.createObjectURL(blob);
  downloadUrls.add(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = `neural-growth-seed-${parameters.seed}.png`;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    downloadUrls.delete(url);
  }, 1000);
}

function runAction(action) {
  try {
    Promise.resolve(action()).catch((error) => displayError(error));
  } catch (error) {
    displayError(error);
  }
}

function pointerPosition(event) {
  const rectangle = elements.canvas.getBoundingClientRect();
  const scale = Math.min(
    rectangle.width / elements.canvas.width,
    rectangle.height / elements.canvas.height,
  );
  const width = elements.canvas.width * scale;
  const height = elements.canvas.height * scale;
  const left = rectangle.left + (rectangle.width - width) / 2;
  const top = rectangle.top + (rectangle.height - height) / 2;
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.min(
      parameters.size - 1,
      Math.max(
        0,
        Math.floor(((event.clientX - left) / width) * parameters.size),
      ),
    ),
    // WebGL state row zero is displayed at the bottom of the canvas.
    y:
      parameters.size -
      1 -
      Math.min(
        parameters.size - 1,
        Math.max(
          0,
          Math.floor(((event.clientY - top) / height) * parameters.size),
        ),
      ),
  };
}

function disturbAtPointer(event) {
  if (!runtime || loading || disposed || pageSuspended) return;
  const position = pointerPosition(event);
  if (position) runAction(() => disturb(position.x, position.y));
}

function resizeDisplay() {
  if (disposed) return;
  const size = Math.max(
    256,
    Math.min(
      2048,
      Math.round(
        elements.viewport.clientWidth *
          Math.min(window.devicePixelRatio || 1, 2),
      ),
    ),
  );
  if (elements.canvas.width === size && elements.canvas.height === size) return;
  elements.canvas.width = elements.canvas.height = size;
  runAction(draw);
}

function visibilityChanged() {
  resetTiming();
  updateControls();
  scheduleFrame();
}

function releasePointer() {
  if (pointerId !== null && elements.canvas.hasPointerCapture(pointerId))
    elements.canvas.releasePointerCapture(pointerId);
  pointerId = null;
}

function abortLoading() {
  loadEpoch += 1;
  loading = false;
  for (const controller of fetchControllers) controller.abort();
  fetchControllers.clear();
  checkpointPromise = null;
}

function pageHidden(event) {
  if (!event.persisted) {
    dispose();
    return;
  }
  // A BFCache page can return without re-executing its module. Preserve its state.
  pageSuspended = true;
  resetTiming();
  abortLoading();
  releasePointer();
  updateControls();
}

function pageShown(event) {
  if (!event.persisted || disposed) return;
  pageSuspended = false;
  resetTiming();
  if (!runtime) void replaceRuntime();
  else {
    updateControls();
    scheduleFrame();
  }
}

function dispose() {
  if (disposed) return;
  disposed = true;
  playing = false;
  resetTiming();
  abortLoading();
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls.clear();
  runtime?.dispose();
  checkpoint = null;
  releasePointer();
  resizeObserver.disconnect();
  document.removeEventListener("visibilitychange", visibilityChanged);
  window.removeEventListener("pagehide", pageHidden);
  window.removeEventListener("pageshow", pageShown);
}

elements.play.addEventListener("click", () => (playing ? pause() : play()));
elements.step.addEventListener("click", () => runAction(singleStep));
elements.restart.addEventListener("click", () => runAction(() => restart()));
elements.disturb.addEventListener("click", () => runAction(() => disturb()));
elements.snapshot.addEventListener("click", () => runAction(downloadSnapshot));
elements.seed.addEventListener("change", () =>
  runAction(() => setSeed(elements.seed.value)),
);
elements.size.addEventListener("change", () =>
  runAction(() => setSize(elements.size.value)),
);
elements.speed.addEventListener("input", () =>
  runAction(() => setSpeed(elements.speed.value)),
);
elements.palette.addEventListener("change", () =>
  runAction(() => setPalette(elements.palette.value)),
);
elements.canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !runtime || loading || disposed || pageSuspended)
    return;
  pointerId = event.pointerId;
  elements.canvas.setPointerCapture(pointerId);
  disturbAtPointer(event);
});
elements.canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId === pointerId) disturbAtPointer(event);
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
  elements.canvas.addEventListener(type, (event) => {
    if (event.pointerId === pointerId) pointerId = null;
  });
document.addEventListener("visibilitychange", visibilityChanged);
window.addEventListener("pagehide", pageHidden);
window.addEventListener("pageshow", pageShown);
const resizeObserver = new ResizeObserver(resizeDisplay);
resizeObserver.observe(elements.viewport);

// Development-only validation hook; never registered with the main application.
window.neuralGrowthPrototype = Object.freeze({
  get runtime() {
    return runtime;
  },
  play,
  pause,
  step: singleStep,
  restart,
  setSeed,
  setSize,
  setSpeed,
  setPalette,
  disturb,
  snapshot,
  reloadCheckpoint: () => replaceRuntime({ reload: true }),
  getStatus: () => ({
    ready: Boolean(runtime && !loading && !disposed && !pageSuspended),
    playing,
    loading,
    hidden: document.hidden,
    disposed,
    pageSuspended,
    error: errorMessage,
    ...parameters,
  }),
});

resizeDisplay();
void replaceRuntime();
