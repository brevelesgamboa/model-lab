import test from "node:test";
import assert from "node:assert/strict";
import { NeuralGrowthModel } from "../../assets/js/models/neural-growth.js";
import { AudioResponse, RECOVERY_POLICY } from "../../assets/js/models/neural-growth/audio-response.js";

const probe = (extra = {}) => ({
  generation: 7,
  steps: 200,
  activeSeconds: 10,
  timestamp: 10000,
  rgbContrast: 0.1,
  rgbEnergy: 0.2,
  rgbDelta: 0.01,
  hiddenEnergy: 0.2,
  hiddenDelta: 0.02,
  clipping: 0,
  coverage: 1,
  eligible: new Uint8Array(1024).fill(255),
  ...extra,
});
function setup() {
  const model = new NeuralGrowthModel({ capabilities: {} });
  model._activePattern = "audit";
  model._parameters.automaticRecovery = true;
  model._clockRunning = true;
  model._runtime = {
    generation: 7,
    size: 256,
    steps: 200,
    coordinateTransform: "spiral",
    twist: (89 * Math.PI) / 180,
    rotation: 0,
    vitalityProbe: probe(),
    monitorVitality() {
      assert.fail("Snapshot must not schedule GPU work");
    },
    readState() {
      assert.fail("Snapshot must not read GPU state");
    },
  };
  return model;
}
function learn(model) {
  for (let i = 0; i < 4; i++)
    model._vitalityWatchdog.observe(probe({ steps: 100 + i }), {
      checkpoint: "audit",
      size: 256,
      generation: 7,
      timestamp: i * 500,
      enabled: true,
      provenance: { coordinateTransform: "cartesian" },
    });
}

test("cached snapshot is detached, immutable and reports geometry, baseline and aligned display", () => {
  const model = setup();
  learn(model);
  model._parameters.coordinateTransform = "spiral";
  model._parameters.twist = 90;
  model.setDiagnosticsBaseParameters({ ...model.parameters, twist: 35 });
  model.setVitalityDisplayMetrics({
    modelId: model.id,
    timestamp: 10000,
    generation: 7,
    steps: 200,
    frameId: 3,
    metrics: { signalMean: 0, signalDeviation: 0 },
  });
  const d = model.getVitalityDiagnostics(10000);
  assert.equal(d.state, "healthy");
  assert.equal(d.baseline.status, "locked");
  assert.equal(d.baseline.provenance.geometry.coordinateTransform, "cartesian");
  assert.equal(
    Object.isFrozen(
      model._vitalityWatchdog.baselines.get("audit:256:0").provenance.geometry,
    ),
    false,
  );
  assert.equal(d.geometry.base.twist, 35);
  assert.equal(d.geometry.modulated.twist, 90);
  assert.equal(d.geometry.applied.twist, 89);
  assert.equal(d.geometry.effectiveSpiralTwistDegrees, 89);
  assert.equal(d.display.discrepancy, true);
  assert.equal(d.display.upstreamNonfinite, "unavailable");
  assert.equal(d.probe.eligibleCoveragePercent, 100);
  assert.throws(() => {
    d.geometry.base.twist = 0;
  }, TypeError);
  assert.equal(model.getVitalityDiagnostics(11000).probe.ageMs, 1000);
  assert.equal(model._vitalityWatchdog.lastStep, 103);
  model.setVitalityDisplayMetrics({
    modelId: model.id,
    timestamp: 10000,
    generation: 6,
    metrics: {},
  });
  assert.equal(model.getVitalityDiagnostics(10000).display.discrepancy, null);
});

test("blockers distinguish manual hold, opt-out, missing baseline, eligibility, pause, cooldown and cap", () => {
  const model = setup();
  model._parameters.automaticRecovery = false;
  model._vitalityWatchdog.noteManualEdit(9000);
  model._runtime.vitalityProbe = probe({ eligible: new Uint8Array(1024) });
  let d = model.getVitalityDiagnostics(10000);
  assert.equal(d.primaryBlocker, "recovery-off");
  for (const blocker of [
    "recovery-off",
    "manual-hold",
    "no-baseline",
    "no-eligible-seed",
  ])
    assert.ok(d.activeBlockers.includes(blocker));
  assert.equal(d.blockerDetails["manual-hold"].remainingSeconds, 7);
  model._vitalityWatchdog.recordRecovery(1000);
  model._vitalityWatchdog.recordRecovery(9000);
  d = model.getVitalityDiagnostics(10000);
  assert.equal(d.blockerDetails.cooldown.remainingSeconds, 9);
  assert.equal(d.blockerDetails["rate-cap"].remainingSeconds, 51);
  d = model.getVitalityDiagnostics(20000);
  assert.ok(!d.activeBlockers.includes("cooldown"));
  assert.ok(d.activeBlockers.includes("rate-cap"));
  assert.equal(
    model._vitalityWatchdog.attempts.length,
    2,
    "reads must not prune policy state",
  );
  model._clockRunning = false;
  assert.ok(
    model
      .getVitalityDiagnostics(20000)
      .activeBlockers.includes("paused-or-stale"),
  );
});

test("cached diagnostic states distinguish saturation, collapse, stillness, warming and recovery", () => {
  const model = setup();
  learn(model);
  for (const [expected, fields] of [
    ["saturated", { clipping: 0.9 }],
    ["collapsed", { rgbContrast: 0, hiddenEnergy: 0, hiddenDelta: 0 }],
    ["still", { hiddenDelta: 0, rgbDelta: 0 }],
    ["warming-up", { steps: 10 }],
  ]) {
    model._runtime.vitalityProbe = probe(fields);
    assert.equal(model.getVitalityDiagnostics(10000).state, expected);
  }
  model._audioResponse.queueRecovery(9900, 0.5, 0.5);
  assert.equal(model.getVitalityDiagnostics(10000).state, "recovering");
});

test("Test Spore uses production queue, protection, clock and admission limits without probing", () => {
  const model = setup();
  model._parameters.automaticRecovery = false;
  assert.equal(
    model.testRecoverySpore(10000).status,
    "admitted",
    "explicit test bypasses opt-out and baseline",
  );
  assert.equal(model._audioResponse.active.length, 2);
  assert.equal(model._audioResponse.active[0].mode, "seed");
  model._audioResponse.cancel("recovery", "recovery-off");
  assert.equal(
    model._audioResponse.active.length,
    2,
    "an explicit test survives recovery opt-out",
  );
  model._audioResponse.step(10016, 256, (_x, _y, _radius, mode, options) => {
    assert.equal(mode, "seed");
    assert.equal(options.automatic, true);
    assert.equal(options.lockBarrier, true);
  }, undefined, {updates:4,simulationSteps:200});
  assert.ok(model._audioResponse.emittedDose > 0);
  assert.equal(
    model.getVitalityDiagnostics(10000).recovery.attemptsRemaining,
    1,
  );
  model._audioResponse.cancel("all", "unit-test");
  assert.equal(model.testRecoverySpore(10001).reason, "cooldown");
  const blocked = setup();
  blocked._runtime.vitalityProbe = probe({
    coverage: 0,
    eligible: new Uint8Array(1024),
  });
  assert.equal(blocked.testRecoverySpore(10000).reason, "protected-region");
  blocked._runtime.vitalityProbe = probe({ eligible: new Uint8Array(1024) });
  assert.equal(blocked.testRecoverySpore(10000).reason, "no-eligible-seed");
  blocked._runtime.vitalityProbe = probe();
  blocked._recoveryIntent.cells.fill(255);
  blocked._recoveryIntent.revision++;
  assert.equal(blocked.testRecoverySpore(10000).reason, "no-eligible-seed");
  blocked._clockRunning = false;
  assert.equal(blocked.testRecoverySpore(10000).reason, "paused-or-stale");
});

test("Force Probe explicitly schedules and polls once without adding watchdog evidence", () => {
  const model = setup();
  model._clockRunning = false;
  let launches = 0,
    polls = 0;
  model._runtime.vitalityProbeState = { pending: false };
  model._runtime.monitorVitality = (timestamp, _active, options) => {
    assert.equal(options.pollOnly, true);
    if (options.force) {
      launches++;
      model._runtime.vitalityProbeState.pending = true;
    } else if (++polls > 1) {
      model._runtime.vitalityForcedProbe = probe({
        timestamp: 10000,
        forced: true,
        requestId: 1,
      });
      model._runtime.vitalityProbeState.pending = false;
    }
  };
  assert.equal(model.forceVitalityProbe(10000).status, "pending");
  model.forceVitalityProbe(10001);
  model.pollVitalityDiagnostics(10016);
  assert.equal(launches, 1);
  assert.equal(
    model.getVitalityDiagnostics(10016).actions.forceProbe.status,
    "complete",
  );
  assert.equal(model._vitalityWatchdog.lastStep, -1);
  assert.equal(model._vitalityWatchdog.badCount, 0);
});

test("probe failure and stale or incompatible display samples remain explicit", () => {
  const model = setup();
  learn(model);
  model._runtime.vitalityProbeState = {
    unavailable: true,
    error: "Vitality fence failed.",
  };
  const d = model.getVitalityDiagnostics(10000);
  assert.equal(d.state, "uncertain");
  assert.ok(d.activeBlockers.includes("probe-unavailable"));
  assert.equal(d.probeError, "Vitality fence failed.");
  assert.equal(model.forceVitalityProbe(10000).reason, "probe-unavailable");
  model.setVitalityDisplayMetrics({
    modelId: model.id,
    timestamp: 10000,
    generation: 7,
    steps: 200,
    frameId: 4,
    metrics: { signalDeviation: 0 },
  });
  assert.equal(model.getVitalityDiagnostics(15000).display.discrepancy, null);
});

test("spore telemetry reports requested dose, envelope lifetime and cancellation without draining", () => {
  const response = new AudioResponse();
  response.queueRecovery(0, 0.5, 0.5);
  response.step(100, 256, () => {});
  const d = response.getDiagnostics(100, 256);
  assert.equal(d.spores[0].remainingUpdates, RECOVERY_POLICY.updates - 1);
  assert.ok(d.emittedDose > 0);
  assert.ok(d.remainingEnvelopeDose > 0);
  const emitted = d.emittedDose;
  assert.equal(response.getDiagnostics(110, 256).emittedDose, emitted);
  response.cancel("recovery", "manual-control-edit");
  assert.equal(
    response.getDiagnostics(120, 256).lastCancellationReason,
    "manual-control-edit",
  );
});
