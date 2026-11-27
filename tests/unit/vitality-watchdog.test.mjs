import test from "node:test";
import assert from "node:assert/strict";
import {
  VitalityWatchdog,
  RecoveryIntentMask,
  INTENT_SIZE,
} from "../../assets/js/models/neural-growth/vitality-watchdog.js";

const context = (timestamp, extra = {}) => ({
  checkpoint: "texture",
  size: 256,
  generation: 1,
  timestamp,
  enabled: true,
  ...extra,
});
const sample = (steps, extra = {}) => ({
  generation: 1,
  steps,
  activeSeconds: 5,
  rgbContrast: 0.1,
  hiddenEnergy: 0.2,
  hiddenDelta: 0.02,
  clipping: 0,
  rgbDelta: 0.01,
  coverage: 1,
  ...extra,
});
const dead = (steps, extra = {}) =>
  sample(steps, {
    rgbContrast: 0.001,
    hiddenEnergy: 0.001,
    hiddenDelta: 0,
    rgbDelta: 0,
    ...extra,
  });
function established(extra = {}) {
  const watcher = new VitalityWatchdog();
  for (let index = 0; index < 4; index++)
    watcher.observe(sample(100 + index, extra), context(index * 500));
  return watcher;
}

test("warm-up needs both 96 updates and three active seconds; no baseline means uncertainty", () => {
  const watcher = new VitalityWatchdog();
  assert.equal(
    watcher.observe(sample(95, { activeSeconds: 10 }), context(10000)).status,
    "warming-up",
  );
  assert.equal(
    watcher.observe(sample(96, { activeSeconds: 2.9 }), context(11000)).status,
    "warming-up",
  );
  for (let i = 97; i < 110; i++)
    assert.equal(
      watcher.observe(dead(i), context(i * 500)).status,
      "uncertain",
    );
  for (let i = 110; i < 113; i++)
    assert.equal(
      watcher.observe(sample(i), context(i * 500)).status,
      "learning",
    );
  assert.equal(watcher.observe(sample(113), context(57000)).status, "healthy");
});

test("static healthy and dark energetic textures never recover for stillness alone", () => {
  const watcher = established({
    rgbContrast: 0.012,
    hiddenDelta: 0,
    rgbDelta: 0,
  });
  for (let i = 104; i < 140; i++) {
    const result = watcher.observe(
      sample(i, { rgbContrast: 0.012, hiddenDelta: 0, rgbDelta: 0 }),
      context(i * 500),
    );
    assert.equal(result.status, "still");
    assert.equal(result.recover, false);
  }
});

test("hidden energy or ongoing hidden delta protects a visually quiet field", () => {
  const watcher = established();
  for (let i = 104; i < 120; i++) {
    assert.equal(
      watcher.observe(
        dead(i, i % 2 ? { hiddenEnergy: 0.2 } : { hiddenDelta: 0.02 }),
        context(i * 500),
      ).recover,
      false,
    );
    assert.equal(watcher.badCount, 0);
  }
});

test("collapse needs three distinct stepped probes and remains diagnostic when opted out", () => {
  const watcher = established();
  assert.equal(watcher.observe(dead(110), context(5000)).badCount, 1);
  for (let i = 0; i < 10; i++)
    assert.equal(watcher.observe(dead(110), context(5100 + i)).recover, false);
  assert.equal(watcher.observe(dead(111), context(5500)).badCount, 2);
  assert.equal(
    watcher.observe(dead(112), context(6000, { enabled: false })).recover,
    false,
  );
  assert.equal(watcher.assessment.status, "collapsed");
  assert.equal(watcher.observe(dead(113), context(6500)).recover, true);
  assert.equal(watcher.observe(sample(114), context(7000)).badCount, 0);
});

test("severe raw-state clipping can recover only after a healthy baseline exists", () => {
  const initial = new VitalityWatchdog();
  for (let i = 100; i < 110; i++)
    assert.equal(
      initial.observe(sample(i, { clipping: 0.99 }), context(i * 500)).status,
      "uncertain",
    );
  const watcher = established();
  for (let i = 104; i < 107; i++) {
    const result = watcher.observe(
      sample(i, { clipping: 0.8 }),
      context(i * 500),
    );
    assert.equal(result.recover, i === 106);
  }
  assert.equal(watcher.assessment.reason, "saturation");
});

test("frozen/erased coverage, pointer holds and eight-second manual holds reset bad evidence", () => {
  const watcher = established();
  watcher.observe(dead(104), context(2000));
  assert.equal(
    watcher.observe(dead(105, { coverage: 0 }), context(2500)).status,
    "protected",
  );
  assert.equal(watcher.badCount, 0);
  watcher.noteManualEdit(3000);
  assert.equal(
    watcher.observe(dead(106), context(10999)).status,
    "manual-hold",
  );
  assert.equal(
    watcher.observe(dead(107), context(11000, { pointerDown: true })).status,
    "manual-hold",
  );
  assert.equal(watcher.observe(dead(108), context(12000)).badCount, 1);
  watcher.suspend();
  assert.equal(watcher.badCount, 0);
});

test("cooldown and two-attempt rolling-minute cap apply to actual admitted recoveries", () => {
  const watcher = established();
  let step = 110;
  const evidence = (timestamp) => {
    let result;
    for (let i = 0; i < 3; i++)
      result = watcher.observe(dead(step++), context(timestamp + i));
    return result;
  };
  assert.equal(evidence(5000).recover, true);
  watcher.recordRecovery(5002);
  assert.equal(evidence(10000).status, "cooldown");
  assert.equal(evidence(15002).recover, true);
  watcher.recordRecovery(15004);
  assert.equal(evidence(30000).status, "rate-cap");
  assert.equal(evidence(65003).recover, true);
});

test("baselines are checkpoint/grid-specific; generations and protection changes reject old evidence", () => {
  const watcher = established();
  assert.equal(
    watcher.observe(dead(110), context(5000, { checkpoint: "other" })).status,
    "uncertain",
  );
  assert.equal(
    watcher.observe(dead(111), context(5500, { size: 512 })).status,
    "uncertain",
  );
  watcher.observe(dead(112), context(6000));
  assert.equal(
    watcher.observe(dead(113), context(6500, { generation: 2 })).status,
    "uncertain",
  );
  assert.equal(
    watcher.observe(
      dead(114, { generation: 2 }),
      context(7000, { generation: 2 }),
    ).badCount,
    1,
  );
  assert.equal(
    watcher.observe(
      dead(115, { generation: 2 }),
      context(7500, { generation: 2, protectionRevision: 1 }),
    ).status,
    "suspected-collapse",
  );
});

test("coarse erase protection wraps, survives until painting, and can be explicitly cleared", () => {
  const mask = new RecoveryIntentMask();
  mask.edit(0, 0, 10, 256, true);
  assert.equal(mask.allows(0.01, 0.01), false);
  assert.equal(mask.allows(0.99, 0.99), false);
  assert.equal(mask.allows(0.5, 0.5), true);
  const revision = mask.revision;
  mask.edit(4, 4, 8, 256, false);
  assert.equal(mask.allows(0.015, 0.015), true);
  assert.ok(mask.cells.some(Boolean));
  assert.ok(mask.revision > revision);
  assert.equal(mask.cells.length, INTENT_SIZE ** 2);
  mask.clear();
  assert.equal(mask.cells.some(Boolean), false);
});

test("resizing intent protection follows toroidal state tiling and clearing restores its baseline scope", () => {
  const mask = new RecoveryIntentMask();
  const empty = mask.signature;
  mask.edit(0, 0, 8, 128, true);
  mask.resize(128, 256);
  assert.equal(mask.allows(0.01, 0.01), false);
  assert.equal(mask.allows(0.51, 0.51), false);
  mask.clear();
  assert.equal(mask.signature, empty);
  const watcher = established();
  watcher.observe(dead(110), context(5000, { protectionRevision: 123 }));
  assert.equal(watcher.observe(dead(111), context(6000)).badCount, 2);
});
