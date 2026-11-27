import test from "node:test";
import assert from "node:assert/strict";
import {
  VitalityWatchdog,
  classifyVitality,
  selectRecoverySeeds,
  WATCHDOG_POLICY,
} from "../../assets/js/models/neural-growth/vitality-watchdog.js";
import { RECOVERY_POLICY } from "../../assets/js/models/neural-growth/audio-response.js";
import { NeuralGrowthModel } from "../../assets/js/models/neural-growth.js";

const context = (timestamp, extra = {}) => ({
  timestamp,
  checkpoint: "texture",
  size: 128,
  generation: 1,
  enabled: true,
  ...extra,
});
const sample = (steps, extra = {}) => ({
  steps,
  generation: 1,
  timestamp: 1000,
  activeSeconds: 10,
  rgbContrast: 0.1,
  nativeContrast: 0.2,
  nativeBrightness: 0.5,
  rgbDelta: 0.01,
  nativeDelta: 0.02,
  hiddenEnergy: 0.2,
  hiddenDelta: 0.02,
  clipping: 0,
  rgbClipping: 0,
  nativeBlackCoverage: 0,
  nativeWhiteCoverage: 0,
  coverage: 1,
  eligible: new Uint8Array(1024).fill(255),
  ...extra,
});
const flat = (steps, extra = {}) =>
  sample(steps, {
    rgbContrast: 0,
    nativeContrast: 0,
    rgbDelta: 0,
    nativeDelta: 0,
    hiddenDelta: 0,
    hiddenEnergy: 0.3,
    ...extra,
  });
function established(fields = {}) {
  const watcher = new VitalityWatchdog();
  for (let n = 100; n < 104; n++)
    watcher.observe(sample(n, fields), context(n * 100));
  return watcher;
}

test("diagnoses separate visible flatness, latent collapse and RGB-only saturation", () => {
  const base = sample(100);
  for (const [diagnosis, fields] of [
    ["visible-flat", {}],
    ["visible-flat", { rgbContrast: 0.06, nativeBlackCoverage: 1 }],
    ["latent-collapse", { hiddenEnergy: 0 }],
    ["saturation", { rgbClipping: 1, clipping: 0.25, nativeWhiteCoverage: 1 }],
  ]) {
    const probe = flat(110, fields);
    assert.equal(classifyVitality(probe, base).diagnosis, diagnosis);
    const watcher = established();
    for (let n = 0; n < 3; n++) {
      const result = watcher.observe(
        { ...probe, steps: 110 + n },
        context(12000 + n * 500),
      );
      assert.equal(result.recover, n === 2);
      assert.equal(result.diagnosis, diagnosis);
    }
  }
});

test("dark or static healthy textures, moving latent state and noncanonical display do not falsely recover", () => {
  for (const fields of [
    {
      rgbContrast: 0.012,
      nativeContrast: 0,
      nativeBrightness: 0,
      nativeBlackCoverage: 1,
      hiddenDelta: 0,
      rgbDelta: 0,
      nativeDelta: 0,
    },
    { hiddenDelta: 0, rgbDelta: 0, nativeDelta: 0 },
    {
      rgbClipping: 1,
      clipping: 0.25,
      hiddenDelta: 0,
      rgbDelta: 0,
      nativeDelta: 0,
    },
  ]) {
    const watcher = established(fields);
    for (let n = 110; n < 120; n++) {
      const result = watcher.observe(sample(n, fields), context(n * 500));
      assert.equal(result.recover, false);
      assert.equal(result.status, "still");
      assert.equal(watcher.badCount, 0);
    }
  }
  assert.equal(
    classifyVitality(flat(110, { hiddenDelta: 0.02 }), sample(100)).severe,
    false,
  );
  assert.equal(
    classifyVitality(flat(110, { rgbDelta: 0.02 }), sample(100)).severe,
    false,
  );
  assert.equal(
    classifyVitality(
      flat(110, { rgbContrast: 0.06, nativeBlackCoverage: 1 }),
      sample(100),
      { nativeProjectionReliable: false },
    ).severe,
    false,
  );
  assert.equal(
    classifyVitality(
      sample(110, { hiddenDelta: null, rgbDelta: null }),
      sample(100),
    ).state,
    "uncertain",
  );
});

test("trusted baselines survive manual geometry holds and compatible protection scopes", () => {
  const watcher = established();
  watcher.noteManualEdit(12000);
  assert.equal(
    watcher.observe(flat(110), context(19999)).status,
    "manual-hold",
  );
  assert.equal(
    watcher.observe(flat(111), context(20000, { protectionRevision: 42 }))
      .status,
    "suspected-collapse",
  );
  const diagnostics = watcher.getDiagnostics(
    flat(111),
    context(20000, { protectionRevision: 42 }),
  );
  assert.equal(diagnostics.baseline.status, "locked");
  assert.equal(diagnostics.baseline.sourceKey, "texture:128:0");
  assert.equal(
    watcher.observe(
      flat(112, { coverage: 0.3 }),
      context(20500, { protectionRevision: 43 }),
    ).status,
    "uncertain",
  );
  assert.equal(
    watcher.observe(flat(113), context(21000, { checkpoint: "other" })).status,
    "uncertain",
  );
});

test("eligible seeds accept rounded 3-of-4 coverage and stay widely separated on the torus", () => {
  const model = new NeuralGrowthModel({ capabilities: {} });
  const eligible = new Uint8Array(1024);
  eligible[0] = 191;
  eligible[1] = 190;
  eligible[528] = 255;
  const probe = sample(200, { eligible });
  assert.deepEqual(model._eligibleRecoverySeeds(probe), [0, 528]);
  assert.deepEqual(
    selectRecoverySeeds([0, 31]),
    [0],
    "Adjacent across the wrap is still adjacent",
  );
  assert.deepEqual(
    selectRecoverySeeds([0, 1, 2]),
    [0],
    "No overlapping spores in a tiny eligible pocket",
  );
  assert.deepEqual(selectRecoverySeeds([0, 528]), [0, 528]);
  const selected = selectRecoverySeeds(
    Array.from({ length: 1024 }, (_, i) => i),
    397,
  );
  const dx = Math.abs((selected[0] % 32) - (selected[1] % 32)) / 32,
    dy =
      Math.abs(Math.floor(selected[0] / 32) - Math.floor(selected[1] / 32)) /
      32;
  assert.ok(Math.hypot(Math.min(dx, 1 - dx), Math.min(dy, 1 - dy)) > 0.7);
  model._recoveryIntent.cells[0] = 255;
  model._recoveryIntent.revision++;
  assert.deepEqual(model._eligibleRecoverySeeds(probe), [528]);
  assert.deepEqual(selectRecoverySeeds([]), []);
});

function modelWithRuntime() {
  const model = new NeuralGrowthModel({ capabilities: {} });
  model._activePattern = "texture";
  model._clockRunning = true;
  model._parameters.automaticRecovery = true;
  model._runtime = {
    size: 128,
    steps: 200,
    generation: 1,
    vitalityProbe: sample(200),
    step(n) {
      this.steps += n;
    },
    disturb(_x, _y, _radius, mode, options) {
      assert.equal(mode, "seed");
      assert.equal(options.automatic, true);
      assert.equal(options.lockBarrier, true);
    },
    monitorVitality() {
      assert.fail("No extra routine probes");
    },
    readState() {
      assert.fail("No state readback");
    },
  };
  return model;
}

test("Automatic recovery toggle preserves existing manual hold without creating a new one", () => {
  const model = modelWithRuntime();
  const initial = model._vitalityWatchdog.manualUntil;
  model.onParameterChange("automaticRecovery", true);
  assert.equal(model._vitalityWatchdog.manualUntil, initial);
  model.onParameterChange("rotation", 30);
  const actualEdit = model._vitalityWatchdog.manualUntil;
  assert.ok(actualEdit > performance.now());
  model.onParameterChange("automaticRecovery", false);
  model.onParameterChange("automaticRecovery", true);
  assert.equal(model._vitalityWatchdog.manualUntil, actualEdit);
});

test("admission, meaningful application and cancellation have separate counters and rate charging", () => {
  const model = modelWithRuntime(),
    watcher = model._vitalityWatchdog;
  const first = model._queueRecoverySpores(model._runtime.vitalityProbe, 1000);
  assert.equal(first.status, "admitted");
  assert.equal(watcher.counters.admitted, 1);
  assert.equal(watcher.counters.applied, 0);
  assert.equal(watcher.attempts.length, 0);
  model._advanceSimulation(1, 1001);
  assert.ok(model._audioResponse.emittedDose < RECOVERY_POLICY.meaningfulDose);
  model.cancelAudio({ all: true, reason: "clock-paused" });
  assert.equal(watcher.counters.cancelled, 1);
  assert.equal(watcher.attempts.length, 0);
  assert.equal(watcher.limits(1002).cooldown, 0);
  model._queueRecoverySpores(model._runtime.vitalityProbe, 2000);
  model._advanceSimulation(4, 2001);
  assert.equal(watcher.counters.admitted, 2);
  assert.equal(watcher.counters.applied, 1);
  assert.equal(watcher.attempts.length, 1);
  model.cancelAudio({ all: true, reason: "manual-control-edit" });
  assert.equal(watcher.counters.cancelled, 2);
  assert.equal(watcher.attempts.length, 1);
  const diagnostics = model.getVitalityDiagnostics(2001);
  assert.equal(diagnostics.recovery.counters.applied, 1);
  assert.equal(diagnostics.recovery.lastOutcome.status, "cancelled");
  assert.equal(
    diagnostics.recovery.lastCancellationReason,
    "manual-control-edit",
  );
});

test("a generation change cancels a queued rescue before dispatch without spending an attempt", () => {
  const model = modelWithRuntime();
  model._queueRecoverySpores(model._runtime.vitalityProbe, 1000);
  model._runtime.generation++;
  model._runtime.disturb = () =>
    assert.fail("Stale rescue must never dispatch");
  model._advanceSimulation(1, 1001);
  assert.equal(model._vitalityWatchdog.counters.cancelled, 1);
  assert.equal(model._vitalityWatchdog.attempts.length, 0);
});

function delivered() {
  const watcher = established();
  watcher.admitRecovery("attempt", 12000, context(12000), flat(120));
  watcher.handleRecoveryEvent({
    type: "dose",
    attemptId: "attempt",
    dose: 1,
    steps: 121,
    timestamp: 12001,
  });
  watcher.handleRecoveryEvent({
    type: "delivered",
    attemptId: "attempt",
    steps: 168,
    timestamp: 12002,
  });
  return watcher;
}

test("disabling recovery or pausing cancels post-delivery observation exactly once", () => {
  for (const action of ["disable", "pause"]) {
    const model = modelWithRuntime();
    model._vitalityWatchdog = delivered();
    if (action === "disable") model.onParameterChange("automaticRecovery", false);
    else model.setClockRunning(false);
    assert.equal(model._vitalityWatchdog.pending, null);
    assert.equal(model._vitalityWatchdog.counters.cancelled, 1);
    model.cancelAudio({all:true});
    assert.equal(model._vitalityWatchdog.counters.cancelled, 1);
    assert.equal(model._vitalityWatchdog.attempts.length, 1, "Applied attempts retain their rate charge");
  }
});

test("outcomes require sustained contrast after delivery and use updates rather than elapsed wall time", () => {
  const watcher = delivered();
  watcher.observe(sample(169), context(13000));
  assert.equal(
    watcher.counters.succeeded,
    0,
    "The seed itself is not a successful outcome",
  );
  watcher.observe(sample(200), context(14000));
  watcher.observe(sample(200), context(999999));
  assert.equal(
    watcher.counters.failed,
    0,
    "Wall time without an update cannot expire observation",
  );
  watcher.observe(sample(232), context(1000000));
  assert.equal(watcher.counters.succeeded, 0);
  watcher.observe(sample(256), context(1000001));
  assert.equal(watcher.counters.succeeded, 1);
  assert.equal(watcher.counters.failed, 0);
  assert.equal(watcher.counters.applied, 1);
  assert.equal(watcher.lastOutcome.reason, "sustained-contrast");
});

test("transient seed contrast is not success and a failed rescue has an exact update deadline", () => {
  const watcher = delivered();
  watcher.observe(sample(170), context(13000));
  watcher.observe(flat(232), context(14000));
  watcher.observe(
    flat(168 + WATCHDOG_POLICY.observationUpdates),
    context(15000),
  );
  assert.equal(watcher.counters.succeeded, 0);
  assert.equal(watcher.counters.failed, 1);
  assert.equal(watcher.lastOutcome.reason, "no-sustained-contrast");
});
