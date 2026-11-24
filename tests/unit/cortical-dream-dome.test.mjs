import test from "node:test";
import assert from "node:assert/strict";
import {
  createDomeMesh,
  DomeCamera,
} from "../../assets/js/render/dome-mesh.js";
import {
  FeatureHeatmapEstimator,
  computeFeatureHeatmap,
  validateFeatureTarget,
} from "../../assets/js/models/inception-feature-map.js";
import {
  CorticalDreamDomeModel,
  DOME_NCA_PRESETS,
} from "../../assets/js/models/cortical-dream-dome.js";

test("the dome closes its seam and poles with nondegenerate inward triangles and 16-bit indices", () => {
  const { vertices: v, indices } = createDomeMesh();
  assert.equal(v.length, 65536 * 5);
  assert.equal(indices.length, 388620);
  for (let y = 0; y < 256; y++)
    assert.deepEqual(
      [...v.slice(y * 256 * 5, y * 256 * 5 + 3)],
      [...v.slice((y * 256 + 255) * 5, (y * 256 + 255) * 5 + 3)],
    );
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [...indices.slice(i, i + 3)].map((index) => [
      ...v.slice(index * 5, index * 5 + 3),
    ]);
    const ab = b.map((n, j) => n - a[j]),
      ac = c.map((n, j) => n - a[j]);
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    assert.ok(normal.reduce((sum, n, j) => sum + n * a[j], 0) < 0);
  }
  assert.throws(() => createDomeMesh(257), RangeError);
});

test("the first-person camera stays at the origin, looks through its center and clamps pitch at 89 degrees", () => {
  const camera = new DomeCamera();
  for (const delta of [
    [0, 0],
    [280, 100],
    [100000, 100000],
    [-100000, -100000],
  ]) {
    camera.look(...delta);
    const { view, projection, direction } = camera.matrices(1.5);
    assert.ok([...view, ...projection, ...direction].every(Number.isFinite));
    assert.deepEqual([...view.slice(12)], [0, 0, 0, 1]);
    assert.ok(Math.abs(camera.pitch) <= (89 * Math.PI) / 180);
    assert.ok(Math.abs(camera.yaw) <= Math.PI);
    const transformed = [0, 1, 2].map((row) =>
      direction.reduce((sum, n, col) => sum + view[col * 4 + row] * n, 0),
    );
    transformed.forEach((n, i) =>
      assert.ok(Math.abs(n - [0, 0, -1][i]) < 1e-6),
    );
  }
  camera.reset();
  assert.equal(camera.yaw, 0);
  assert.equal(camera.pitch, 0);
});

test("feature workers reject invalid targets, cancelled captures and replaced results, and release each worker", async () => {
  assert.throws(() => validateFeatureTarget("Mixed_5b", 120), RangeError);
  assert.throws(() => validateFeatureTarget("Conv2d_4a_3x3", 192), RangeError);
  const workers = [],
    captures = [];
  const estimator = new FeatureHeatmapEstimator({
    capture: () => new Promise((resolve) => captures.push(resolve)),
    createWorker: () => {
      const worker = {
        terminated: false,
        postMessage(data) {
          this.data = data;
        },
        terminate() {
          this.terminated = true;
        },
      };
      workers.push(worker);
      return worker;
    },
  });
  const first = estimator.estimate({}, "mixed_5b", 120);
  const rejectedFirst = assert.rejects(first, { name: "AbortError" });
  await Promise.resolve();
  const next = estimator.estimate({}, "mixed_6a", 42);
  await Promise.resolve();
  let closed = false;
  captures[0]({
    close() {
      closed = true;
    },
  });
  await rejectedFirst;
  await Promise.resolve();
  assert.equal(closed, true);
  captures[1]({ close() {} });
  await new Promise((resolve) => setImmediate(resolve));
  workers[0].onmessage({
    data: {
      type: "result",
      width: 2,
      height: 2,
      values: new Float32Array([0, 1, 0.5, 0.2]),
    },
  });
  const result = await next;
  assert.equal(result.layer, "mixed_6a");
  assert.equal(result.channel, 42);
  assert.equal(workers[0].terminated, true);
  assert.equal(estimator.runs, 1);
  const abort = new AbortController();
  const third = estimator.estimate({}, "mixed_5b", 120, {
    signal: abort.signal,
  });
  const rejectedThird = assert.rejects(third, { name: "AbortError" });
  await Promise.resolve();
  captures[2]({ close() {} });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await rejectedThird;
  assert.equal(workers[1].terminated, true);
  assert.equal(estimator.pending, null);
});

test("heatmap textures use bilinear float storage, retain a flat map on failure and never upload an aborted result", async () => {
  const uploads = [],
    params = [];
  const gl = {
    TEXTURE_2D: 1,
    R16F: 2,
    RED: 3,
    FLOAT: 4,
    LINEAR: 5,
    CLAMP_TO_EDGE: 6,
    createTexture: () => ({}),
    bindTexture() {},
    pixelStorei() {},
    texParameteri(...args) {
      params.push(args);
    },
    texImage2D(...args) {
      uploads.push(args);
    },
  };
  const result = await computeFeatureHeatmap(gl, {}, "mixed_5b", 120, {
    estimator: {
      estimate: async () => ({
        width: 2,
        height: 2,
        values: new Float32Array([0, 0.25, 0.5, 1]),
        kind: "activation",
      }),
    },
  });
  assert.equal(result.kind, "activation");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1][2], gl.R16F);
  assert.ok(params.some((p) => p[2] === gl.LINEAR));
  const fallback = await computeFeatureHeatmap(gl, {}, "mixed_5b", 120, {
    estimator: {
      estimate: async () => {
        throw new Error("Offline");
      },
    },
  });
  assert.deepEqual([...fallback.values], [0]);
  assert.equal(fallback.error, "Offline");
  const abort = new AbortController();
  const before = uploads.length;
  await assert.rejects(
    computeFeatureHeatmap(gl, {}, "mixed_5b", 120, {
      signal: abort.signal,
      estimator: {
        estimate: async () => {
          abort.abort();
          return result;
        },
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(uploads.length, before + 1);
});

test("DOME_NCA_PRESETS catalog exposes the four biological presets", () => {
  const ids = DOME_NCA_PRESETS.map((p) => p.id);
  assert.ok(ids.includes("membrane-field"));
  assert.ok(ids.includes("filament-network"));
  assert.ok(ids.includes("xeno-reef"));
  assert.ok(ids.includes("mixed4c-439"));
  for (const preset of DOME_NCA_PRESETS) {
    assert.ok(preset.name.length > 0);
    assert.ok(preset.url instanceof URL);
  }
});

test("CorticalDreamDomeModel declares NCA relief and bio-sheen parameters and control sections", () => {
  const model = new CorticalDreamDomeModel();
  const extrude = model.controls.find((c) => c.key === "ncaExtrude");
  const sheen = model.controls.find((c) => c.key === "ncaSheen");
  assert.ok(extrude, "ncaExtrude control must be registered");
  assert.ok(sheen, "ncaSheen control must be registered");
  assert.equal(extrude.type, "range");
  assert.equal(sheen.type, "range");
  assert.equal(extrude.default, 0.45);
  assert.equal(sheen.default, 0.65);

  const geomSection = model.controlSections.find((s) => s.id === "geometry");
  const sheenSection = model.controlSections.find((s) => s.id === "sheen");
  assert.ok(geomSection, "geometry section should be registered");
  assert.equal(
    sheenSection,
    undefined,
    "no duplicate sheen section in generic parameter controls",
  );
  assert.ok(
    geomSection.keys.includes("ncaExtrude"),
    "ncaExtrude should be registered under geometry section alongside other extrusion sliders",
  );

  assert.equal(
    model.isDynamic({ gain: 0, speed: 0, ncaExtrude: 0.45, ncaSheen: 0 }),
    true,
  );
  assert.equal(
    model.isDynamic({ gain: 0, speed: 0, ncaExtrude: 0, ncaSheen: 0.65 }),
    true,
  );
  assert.equal(
    model.isDynamic({ gain: 0, speed: 0, ncaExtrude: 0, ncaSheen: 0 }),
    false,
  );
  model.dispose();
});

test("CorticalDreamDomeModel manages NCA lifecycle, preset switching, resolution toggling, and seeding", async () => {
  const disturbed = [];
  let steps = 0;
  let restarts = 0;
  let disposed = false;
  const mockRuntime = {
    disposed: false,
    lost: false,
    restart() {
      restarts++;
    },
    disturb(...args) {
      disturbed.push(args);
    },
    step(n) {
      steps += n;
    },
    draw() {},
    dispose() {
      this.disposed = true;
      disposed = true;
    },
  };

  const loadedUrls = [];
  const fakeCheckpoint = {
    format: "latent-field-texture-nca-v1",
    id: "unit-fixture",
    name: "Unit fixture",
    layers: [
      { shape: [49, 96], scale: 1, weights: Array(49 * 96).fill(128) },
      { shape: [97, 12], scale: 1, weights: Array(97 * 12).fill(128) },
    ],
  };

  const model = new CorticalDreamDomeModel({
    loadCheckpoint: async (url) => {
      loadedUrls.push(url.href || String(url));
      return fakeCheckpoint;
    },
    createNcaRuntime: ({ size }) => {
      mockRuntime.size = size;
      mockRuntime.disposed = false;
      return mockRuntime;
    },
  });

  await model.initNcaPromise;
  assert.equal(model.ncaPreset, "membrane-field");
  assert.equal(model.ncaSize, 256);
  assert.equal(loadedUrls.length, 1);
  assert.ok(restarts >= 1);
  assert.ok(
    disturbed.length >= 3,
    "initial seed should apply multiple disturbance points",
  );
  assert.ok(steps >= 12, "initial seed should warm up the pattern");

  // Switch preset
  await model.setNcaPreset("xeno-reef");
  assert.equal(model.ncaPreset, "xeno-reef");
  assert.equal(loadedUrls.length, 2);

  // Toggle resolution
  await model.setNcaResolution(128);
  assert.equal(model.ncaSize, 128);
  assert.equal(mockRuntime.size, 128);

  // Reseed / pulse
  const distBefore = disturbed.length;
  model.reseedNca();
  assert.ok(disturbed.length > distBefore);

  // Clean disposal
  model.dispose();
  assert.equal(disposed, true);
  assert.equal(model.ncaRuntime, null);
});

test("CorticalDreamDomeModel vitality watchdog automatically detects low vitality and stagnation to inject feathered spores", async () => {
  const disturbed = [];
  const mockRuntime = {
    disposed: false,
    lost: false,
    size: 256,
    restart() {},
    disturb(...args) {
      disturbed.push(args);
    },
    step() {},
    draw() {},
    dispose() {
      this.disposed = true;
    },
  };

  const fakeCheckpoint = {
    format: "latent-field-texture-nca-v1",
    id: "unit-fixture",
    name: "Unit fixture",
    layers: [
      { shape: [49, 96], scale: 1, weights: Array(49 * 96).fill(128) },
      { shape: [97, 12], scale: 1, weights: Array(97 * 12).fill(128) },
    ],
  };

  const model = new CorticalDreamDomeModel({
    loadCheckpoint: async () => fakeCheckpoint,
    createNcaRuntime: ({ size }) => {
      mockRuntime.size = size;
      mockRuntime.disposed = false;
      return mockRuntime;
    },
  });

  await model.initNcaPromise;

  // Clear startup seed disturbances
  disturbed.length = 0;

  // Normal healthy vitality and activity: no spores triggered
  const normalRes = model.evaluateNcaVitality({ vitality: 0.45, delta: 0.05 });
  assert.equal(normalRes.triggered, false);
  assert.equal(model.ncaActiveSpores.length, 0);
  assert.equal(disturbed.length, 0);

  // First stagnant sample increments counter
  const stag1 = model.evaluateNcaVitality({ vitality: 0.45, delta: 0.003 });
  assert.equal(stag1.triggered, false);
  assert.equal(model.ncaStagnationCounter, 1);

  // Second consecutive stagnant sample confirms stagnation and triggers soft spores
  const stag2 = model.evaluateNcaVitality({ vitality: 0.45, delta: 0.002 });
  assert.equal(stag2.triggered, true);
  assert.ok(model.ncaActiveSpores.length >= 2, "should queue at least 2 soft spores");
  assert.equal(model.ncaStagnationCounter, 0);

  // Stepping active spores applies feathered disturbance over multi-frame duration
  const sporesCount = model.ncaActiveSpores.length;
  const initialDuration = model.ncaActiveSpores[0].duration;
  model.stepActiveSpores();
  assert.ok(disturbed.length >= sporesCount, "disturb should be called for active spores");

  // Step through remaining duration until spores are drained
  for (let f = 1; f < initialDuration + 2; f++) {
    model.stepActiveSpores();
  }
  assert.equal(model.ncaActiveSpores.length, 0, "spores should drain after full duration");

  // Severe vitality drop triggers immediate spore injection
  disturbed.length = 0;
  const severeRes = model.evaluateNcaVitality({ vitality: 0.02, delta: 0.01 });
  assert.equal(severeRes.triggered, true);
  assert.ok(model.ncaActiveSpores.length >= 2);

  model.dispose();
  assert.equal(model.ncaActiveSpores.length, 0);
});

test("Single Bio-Sheen Opacity slider wiring to u_nca_sheen and photo core protection", () => {
  const model = new CorticalDreamDomeModel();
  assert.equal(model.ncaSheen, 0.65);
  assert.equal(model.photoProtection, 0.65);

  model.onParameterChange("ncaSheen", 0.92);
  assert.equal(model.ncaSheen, 0.92);

  model.onParameterChange("photoProtection", 0.25);
  assert.equal(model.photoProtection, 0.25);

  // Ensure no duplicate section in controlSections
  const sections = model.controlSections.map((s) => s.id);
  assert.ok(!sections.includes("sheen"));

  model.dispose();
});

test("CorticalDreamDomeModel resolves patterns from full PATTERNS catalog and injects spores on switch", async () => {
  const { PATTERNS } = await import(
    "../../assets/js/models/neural-growth/patterns.js"
  );
  const bubbly = PATTERNS.find((p) => p.id === "bubbly-0101");
  assert.ok(bubbly, "bubbly-0101 pattern should exist in catalog");

  const loadedUrls = [];
  const fakeCheckpoint = {
    format: "latent-field-texture-nca-v1",
    id: "bubbly-0101",
    name: "Bubbly (0101)",
    layers: [
      { shape: [49, 96], scale: 1, weights: Array(49 * 96).fill(128) },
      { shape: [97, 12], scale: 1, weights: Array(97 * 12).fill(128) },
    ],
  };

  const model = new CorticalDreamDomeModel({
    loadCheckpoint: async (url) => {
      loadedUrls.push(url.href || String(url));
      return fakeCheckpoint;
    },
    createNcaRuntime: ({ size, model: m }) => ({
      size,
      model: m,
      disposed: false,
      lost: false,
      restart() {},
      disturb() {},
      step() {},
      draw() {},
      dispose() {},
    }),
  });

  await model.initNcaPromise;
  assert.equal(model.ncaPreset, "membrane-field");

  // Select pattern from catalog not in default 4 presets
  await model.setNcaPreset("bubbly-0101", bubbly);
  assert.equal(model.ncaPreset, "bubbly-0101");
  assert.equal(model.ncaPresetName, "Bubbly (0101)");
  assert.ok(loadedUrls.some((u) => u.includes("bubbly-0101")));
  // Verify spores injected on pattern switch
  assert.ok(
    model.ncaActiveSpores.length > 0,
    "switching pattern should inject soft spores",
  );

  model.dispose();
});

test("setDomeSliderGuidance renders tag, text, and hides properly", async () => {
  const { setDomeSliderGuidance } = await import(
    "../../assets/js/ui/dome-controls.js"
  );

  const container = {
    hidden: true,
    children: {
      tag: { className: "", textContent: "" },
      text: { textContent: "" },
    },
    querySelector(selector) {
      if (selector === ".control-guidance__tag") return this.children.tag;
      if (selector === ".control-guidance__text") return this.children.text;
      return null;
    },
  };

  // Calling without guidance keeps hidden
  setDomeSliderGuidance(container, null);
  assert.equal(container.hidden, true);

  // Calling with valid guidance sets classes and reveals container
  setDomeSliderGuidance(container, {
    compute: "balanced",
    tag: "SWEET-SPOT",
    text: "Optimal biological relief without surface clipping.",
  });
  assert.equal(container.hidden, false);
  assert.equal(
    container.children.tag.className,
    "control-guidance__tag control-guidance__tag--balanced",
  );
  assert.equal(container.children.tag.textContent, "SWEET-SPOT");
  assert.equal(
    container.children.text.textContent,
    "Optimal biological relief without surface clipping.",
  );

  // Calling with empty text hides again
  setDomeSliderGuidance(container, { text: "" });
  assert.equal(container.hidden, true);
});

test("createDomeNcaControls keeps slider numeric readouts synced on update and input", async () => {
  const { createDomeNcaControls } = await import(
    "../../assets/js/ui/dome-controls.js"
  );

  function createMockElement(initialValue = "") {
    const listeners = {};
    return {
      value: initialValue,
      textContent: initialValue,
      addEventListener(event, fn) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
      },
      dispatchEvent(event) {
        listeners[event]?.forEach((fn) => fn());
      },
    };
  }

  const elements = {
    domeNcaPresetLabel: createMockElement("Membrane Field"),
    domeBrowseNca: createMockElement(),
    domeNcaResolution: createMockElement("256"),
    domeNcaReseed: createMockElement(),
    domeNcaSheen: createMockElement("0.65"),
    domeNcaSheenVal: createMockElement("0.65"),
    domeNcaSheenGuidance: { hidden: true },
    domePhotoProtection: createMockElement("0.65"),
    domePhotoProtectionVal: createMockElement("0.65"),
    domePhotoProtectionGuidance: { hidden: true },
  };

  const model = {
    ncaPresetName: "Membrane Field",
    ncaPresetId: "membrane-field",
    ncaSize: 256,
    ncaSheen: 0.65,
    photoProtection: 0.65,
  };

  const paramsChanged = [];
  const controls = createDomeNcaControls(
    elements,
    model,
    () => true,
    () => true,
    (param, val) => paramsChanged.push({ param, val }),
  );

  // Initial update
  controls.update();
  assert.equal(elements.domeNcaSheenVal.textContent, "0.65");
  assert.equal(elements.domePhotoProtectionVal.textContent, "0.65");

  // Input event on sheen
  elements.domeNcaSheen.value = "0.82";
  elements.domeNcaSheen.dispatchEvent("input");
  assert.equal(model.ncaSheen, 0.82);
  assert.equal(elements.domeNcaSheenVal.textContent, "0.82");

  // Input event on photoProtection
  elements.domePhotoProtection.value = "0.40";
  elements.domePhotoProtection.dispatchEvent("input");
  assert.equal(model.photoProtection, 0.4);
  assert.equal(elements.domePhotoProtectionVal.textContent, "0.40");

  // Update reflects model state
  model.ncaSheen = 0.95;
  model.photoProtection = 0.15;
  controls.update();
  assert.equal(elements.domeNcaSheenVal.textContent, "0.95");
  assert.equal(elements.domePhotoProtectionVal.textContent, "0.15");
});

test("Autonomous drift gently updates camera orientation over frames and yields to manual pointer interaction", () => {
  const model = new CorticalDreamDomeModel();
  assert.equal(model.autonomousDrift, true);

  const initialYaw = model.camera.yaw;
  const initialRoll = model.camera.roll;
  assert.equal(initialRoll, 0);

  // Step several frames of autonomous drift
  for (let i = 0; i < 10; i++) {
    model.updateAutonomousDrift(0.05);
  }

  // Camera orientation should have drifted gently
  assert.notEqual(model.camera.yaw, initialYaw);
  assert.ok(Math.abs(model.camera.yaw - initialYaw) > 0.01);
  assert.ok(Math.abs(model.camera.roll) > 0.001);

  // Yield to manual interaction: disengaging drift immediately stops autonomous motion
  model.setAutonomousDrift(false);
  assert.equal(model.autonomousDrift, false);
  assert.equal(model.camera.roll, 0);

  const frozenYaw = model.camera.yaw;
  const frozenPitch = model.camera.pitch;

  // Further drift steps should NOT alter orientation when drift is disabled
  model.updateAutonomousDrift(0.05);
  assert.equal(model.camera.yaw, frozenYaw);
  assert.equal(model.camera.pitch, frozenPitch);

  // Manual look works without fighting
  model.camera.look(50, 20);
  assert.notEqual(model.camera.yaw, frozenYaw);
  assert.notEqual(model.camera.pitch, frozenPitch);

  model.dispose();
});

test("Simulated rhythmController kick and bass levels trigger NCA ripples and modulate cortical wave parameters", async () => {
  const disturbed = [];
  const fakeCheckpoint = {
    format: "latent-field-texture-nca-v1",
    id: "unit-fixture",
    name: "Unit fixture",
    layers: [
      { shape: [49, 96], scale: 1, weights: Array(49 * 96).fill(128) },
      { shape: [97, 12], scale: 1, weights: Array(97 * 12).fill(128) },
    ],
  };
  const mockRuntime = {
    disposed: false,
    lost: false,
    restart() {},
    disturb(...args) {
      disturbed.push(args);
    },
    step() {},
    draw() {},
    dispose() {},
  };

  const model = new CorticalDreamDomeModel({
    loadCheckpoint: async () => fakeCheckpoint,
    createNcaRuntime: () => mockRuntime,
  });
  await model.initNcaPromise;

  // Initially no active spores from audio
  assert.equal(model.ncaActiveSpores.length, 0);

  // Sub-threshold kick does not trigger ripple
  const resLow = model.onAudioFrame(
    { kick: 0.2, bass: 0.1, activity: 0.1 },
    1000,
  );
  assert.equal(resLow, false);
  assert.equal(model.ncaActiveSpores.length, 0);

  // Strong kick onset triggers localized ripple / spore disturbance
  const resBeat = model.onAudioFrame(
    { kick: 0.85, kickOnset: 0.9, bass: 0.8, activity: 0.7 },
    1200,
  );
  assert.equal(resBeat, true);
  assert.ok(model.ncaActiveSpores.length > 0, "should queue active ripple spore");

  // Stepping spores calls mockRuntime.disturb
  model.stepActiveSpores();
  assert.ok(disturbed.length > 0, "disturb should be called for audio ripple");

  // Debounce: rapid immediate subsequent frame does not spam
  const resSpam = model.onAudioFrame(
    { kick: 0.85, kickOnset: 0.9, bass: 0.8, activity: 0.7 },
    1250,
  );
  assert.equal(resSpam, false);

  // Modulated parameters calculation: bass and activity increase effective gain, speed, and dispersion
  assert.ok(model.audioBass > 0);
  assert.ok(model.audioActivity > 0);

  model.dispose();
});

