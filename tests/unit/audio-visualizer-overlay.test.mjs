import test from "node:test";
import assert from "node:assert/strict";
import {
  AudioVisualizerOverlay,
  DEFAULT_VISUALIZER_CONFIG,
  VISUALIZER_COLOR_PRESETS,
} from "../../assets/js/audio/visualizer-overlay.js";

function createMockCanvas(width = 512, height = 512) {
  const drawnOperations = [];
  const context = {
    imageSmoothingEnabled: false,
    clearRect: (x, y, w, h) => drawnOperations.push(["clearRect", x, y, w, h]),
    beginPath: () => drawnOperations.push(["beginPath"]),
    moveTo: (x, y) => drawnOperations.push(["moveTo", x, y]),
    lineTo: (x, y) => drawnOperations.push(["lineTo", x, y]),
    bezierCurveTo: (...args) => drawnOperations.push(["bezierCurveTo", ...args]),
    closePath: () => drawnOperations.push(["closePath"]),
    stroke: (...args) => drawnOperations.push(["stroke", ...args]),
    fill: (...args) => drawnOperations.push(["fill", ...args]),
    save: () => drawnOperations.push(["save"]),
    restore: () => drawnOperations.push(["restore"]),
    createLinearGradient: () => ({
      addColorStop: () => {},
    }),
    drawImage: (...args) => drawnOperations.push(["drawImage", ...args]),
  };

  return {
    width,
    height,
    hidden: true,
    getContext: () => context,
    drawnOperations,
  };
}

function createMockRhythm(status = "active", hasSignal = true) {
  const frequencyData = new Uint8Array(1024).fill(120);
  const timeDomainData = new Uint8Array(2048).fill(128);
  for (let i = 0; i < timeDomainData.length; i += 1) {
    timeDomainData[i] = Math.round(128 + 60 * Math.sin((i / 32) * Math.PI));
  }

  return {
    status,
    analyser: {
      fftSize: 2048,
    },
    context: {
      sampleRate: 48000,
    },
    getFrequencyData: () => (status === "active" ? frequencyData : null),
    getTimeDomainData: () => (status === "active" ? timeDomainData : null),
    getLevels: () => ({
      bass: hasSignal ? 0.8 : 0,
      kick: hasSignal ? 0.9 : 0,
      kickOnset: hasSignal ? 0.7 : 0,
      activity: hasSignal ? 0.6 : 0,
      bassPhase: 0,
      hasSignal,
    }),
  };
}

test("audio visualizer overlay initializes with valid defaults and color presets", () => {
  const mockCanvas = createMockCanvas();
  const visualizer = new AudioVisualizerOverlay(mockCanvas);

  assert.equal(visualizer.enabled, false);
  assert.equal(visualizer.config.mode, DEFAULT_VISUALIZER_CONFIG.mode);
  assert.equal(visualizer.config.style, "single");
  assert.equal(visualizer.config.fill, "stroke");
  assert.equal(visualizer.config.height, 0.85);
  assert.equal(visualizer.config.position, 0.15);
  assert.equal(visualizer.config.smoothing, 0.65);
  assert.equal(visualizer.config.sensitivity, 1.2);
  assert.equal(visualizer.config.bassEmphasis, 0.6);

  assert.ok(Array.isArray(VISUALIZER_COLOR_PRESETS));
  assert.equal(VISUALIZER_COLOR_PRESETS.length, 5);
  assert.equal(VISUALIZER_COLOR_PRESETS[0].id, "cyan");
});

test("audio visualizer overlay normalizes and clamps configuration parameters", () => {
  const visualizer = new AudioVisualizerOverlay(null);

  const normalized = visualizer.normalizeConfig({
    enabled: true,
    mode: "invalid_mode",
    style: "unknown_style",
    fill: "unsupported_fill",
    height: 99.0, // should clamp to 2.0
    position: -5.0, // should clamp to 0.05
    smoothing: 2.5, // should clamp to 0.95
    sensitivity: 0.1, // should clamp to 0.5
    bassEmphasis: -1.0, // should clamp to 0.0
    opacity: 5.0, // should clamp to 1.0
    color: "not-a-color", // should fallback to default
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.mode, "spectrum");
  assert.equal(normalized.style, "single");
  assert.equal(normalized.fill, "stroke");
  assert.equal(normalized.height, 2.0);
  assert.equal(normalized.position, 0.05);
  assert.equal(normalized.smoothing, 0.95);
  assert.equal(normalized.sensitivity, 0.5);
  assert.equal(normalized.bassEmphasis, 0.0);
  assert.equal(normalized.opacity, 1.0);
  assert.equal(normalized.color, DEFAULT_VISUALIZER_CONFIG.color);
});

test("audio visualizer overlay synchronizes dimensions with target simulation canvas", () => {
  const mockCanvas = createMockCanvas(256, 256);
  const targetCanvas = { width: 1024, height: 1024 };
  const visualizer = new AudioVisualizerOverlay(mockCanvas);

  visualizer.syncDimensions(targetCanvas);
  assert.equal(mockCanvas.width, 1024);
  assert.equal(mockCanvas.height, 1024);
});

test("audio visualizer overlay updates options and notifies subscribers", () => {
  const mockCanvas = createMockCanvas();
  const visualizer = new AudioVisualizerOverlay(mockCanvas);

  let notifiedConfig = null;
  const unsubscribe = visualizer.subscribe((config) => {
    notifiedConfig = config;
  });

  visualizer.setOption("mode", "bass_history");
  assert.equal(visualizer.config.mode, "bass_history");
  assert.ok(notifiedConfig);
  assert.equal(notifiedConfig.mode, "bass_history");

  visualizer.setOptions({
    style: "mirrored",
    fill: "fill",
    color: "#ff00a0",
  });
  assert.equal(visualizer.config.style, "mirrored");
  assert.equal(visualizer.config.fill, "fill");
  assert.equal(visualizer.config.color, "#ff00a0");

  unsubscribe();
  notifiedConfig = null;
  visualizer.setOption("style", "single");
  assert.equal(notifiedConfig, null);
});

test("audio visualizer overlay renders spectrum mode and decays on silence", () => {
  const mockCanvas = createMockCanvas();
  const visualizer = new AudioVisualizerOverlay(mockCanvas);
  visualizer.enabled = true;

  const activeRhythm = createMockRhythm("active", true);
  visualizer.update(1000, activeRhythm, mockCanvas);

  assert.equal(mockCanvas.hidden, false);
  assert.equal(visualizer.isIdle, false);
  assert.ok(mockCanvas.drawnOperations.some((op) => op[0] === "stroke"));

  const silentRhythm = createMockRhythm("idle", false);
  // Simulate several decay frames until it idles cleanly
  for (let frame = 1; frame <= 60; frame += 1) {
    visualizer.update(1000 + frame * 50, silentRhythm, mockCanvas);
  }

  assert.equal(visualizer.isIdle, true);
});

test("audio visualizer overlay renders bass history mode with circular buffer wrapping", () => {
  const mockCanvas = createMockCanvas();
  const visualizer = new AudioVisualizerOverlay(mockCanvas);
  visualizer.setOptions({ enabled: true, mode: "bass_history" });

  const activeRhythm = createMockRhythm("active", true);
  for (let frame = 0; frame < 150; frame += 1) {
    visualizer.update(2000 + frame * 16, activeRhythm, mockCanvas);
  }

  // Wrapped past 128 elements cleanly
  assert.ok(visualizer.bassHead >= 0 && visualizer.bassHead < 128);
  assert.equal(visualizer.isIdle, false);
});

test("audio visualizer overlay renders waveform mode with zero-crossing alignment", () => {
  const mockCanvas = createMockCanvas();
  const visualizer = new AudioVisualizerOverlay(mockCanvas);
  visualizer.setOptions({ enabled: true, mode: "waveform" });

  const activeRhythm = createMockRhythm("active", true);
  visualizer.update(3000, activeRhythm, mockCanvas);

  assert.equal(mockCanvas.hidden, false);
  assert.equal(visualizer.isIdle, false);
  assert.ok(mockCanvas.drawnOperations.some((op) => op[0] === "stroke"));
});

test("audio visualizer overlay composites onto target canvas only when active", () => {
  const mockCanvas = createMockCanvas(512, 512);
  const visualizer = new AudioVisualizerOverlay(mockCanvas);

  const targetCanvas = createMockCanvas(512, 512);

  // Disabled: should not draw
  visualizer.compositeOnto(targetCanvas);
  assert.equal(targetCanvas.drawnOperations.length, 0);

  // Enabled and drawn
  visualizer.enabled = true;
  visualizer.isIdle = false;
  visualizer.compositeOnto(targetCanvas);

  assert.ok(targetCanvas.drawnOperations.some((op) => op[0] === "drawImage"));
});

