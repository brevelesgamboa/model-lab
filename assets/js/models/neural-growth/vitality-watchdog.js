export const WATCHDOG_POLICY = Object.freeze({
  warmupSteps: 96,
  warmupSeconds: 3,
  baselineProbes: 4,
  badProbes: 3,
  manualHold: 8000,
  cooldown: 10000,
  attemptsPerMinute: 2,
});
export const INTENT_SIZE = 32;

export class RecoveryIntentMask {
  constructor() {
    this.cells = new Uint8Array(INTENT_SIZE ** 2);
    this.revision = 0;
  }
  get signature() {
    let hash = 0;
    for (let index = 0; index < this.cells.length; index++)
      if (this.cells[index])
        hash = (Math.imul(hash ^ index, 16777619) + 1) >>> 0;
    return hash;
  }
  resize(oldGrid, newGrid) {
    const previous = this.cells.slice(),
      ratio = newGrid / oldGrid;
    for (let y = 0; y < INTENT_SIZE; y++)
      for (let x = 0; x < INTENT_SIZE; x++) {
        let protectedCell = false;
        for (
          let sy = Math.floor(y * ratio);
          sy < Math.ceil((y + 1) * ratio);
          sy++
        )
          for (
            let sx = Math.floor(x * ratio);
            sx < Math.ceil((x + 1) * ratio);
            sx++
          ) {
            if (previous[(sy % INTENT_SIZE) * INTENT_SIZE + (sx % INTENT_SIZE)])
              protectedCell = true;
          }
        this.cells[y * INTENT_SIZE + x] = protectedCell ? 255 : 0;
      }
    this.revision++;
  }
  clear() {
    this.cells.fill(0);
    this.revision++;
  }
  edit(x, y, radius, gridSize, erase) {
    const scale = gridSize / INTENT_SIZE;
    const reach = radius / scale + (erase ? Math.SQRT1_2 : 0);
    let changed = false;
    for (let row = 0; row < INTENT_SIZE; row++)
      for (let col = 0; col < INTENT_SIZE; col++) {
        const dx = col + 0.5 - x / scale,
          dy = row + 0.5 - y / scale;
        const torus = (value) =>
          value - Math.round(value / INTENT_SIZE) * INTENT_SIZE;
        if (Math.hypot(torus(dx), torus(dy)) > reach) continue;
        const index = row * INTENT_SIZE + col,
          value = erase ? 255 : 0;
        if (this.cells[index] !== value) {
          this.cells[index] = value;
          changed = true;
        }
      }
    if (changed) this.revision++;
    return changed;
  }
  allows(x, y) {
    const col = Math.min(
      INTENT_SIZE - 1,
      Math.max(0, Math.floor(x * INTENT_SIZE)),
    );
    const row = Math.min(
      INTENT_SIZE - 1,
      Math.max(0, Math.floor(y * INTENT_SIZE)),
    );
    return this.cells[row * INTENT_SIZE + col] === 0;
  }
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
export class VitalityWatchdog {
  constructor() {
    this.baselines = new Map();
    this.attempts = [];
    this.manualUntil = -Infinity;
    this.generation = null;
    this.lastStep = -1;
    this.badCount = 0;
    this.assessment = { status: "learning", recover: false };
  }
  suspend() {
    this.badCount = 0;
  }
  noteManualEdit(timestamp) {
    this.manualUntil = timestamp + WATCHDOG_POLICY.manualHold;
    this.suspend();
    this.assessment = { status: "manual-hold", recover: false };
  }
  recordRecovery(timestamp) {
    this.attempts.push(timestamp);
    this.suspend();
  }
  observe(
    probe,
    {
      checkpoint,
      size,
      generation,
      timestamp,
      enabled = false,
      active = true,
      pointerDown = false,
      protectionRevision = 0,
    },
  ) {
    const report = (status, extra = {}) =>
      (this.assessment = {
        status,
        recover: false,
        badCount: this.badCount,
        ...extra,
      });
    if (
      !probe ||
      probe.generation !== generation ||
      ![
        probe.rgbContrast,
        probe.hiddenEnergy,
        probe.clipping,
        probe.coverage,
        probe.steps,
        probe.activeSeconds,
      ].every(Number.isFinite)
    )
      return report("uncertain");
    if (this.generation !== generation) {
      this.generation = generation;
      this.lastStep = -1;
      this.suspend();
    }
    if (probe.steps <= this.lastStep)
      return { ...this.assessment, recover: false };
    this.lastStep = probe.steps;
    if (!active || pointerDown || timestamp < this.manualUntil) {
      this.suspend();
      return report("manual-hold");
    }
    if (probe.coverage < 0.05) {
      this.suspend();
      return report("protected");
    }
    if (
      probe.steps < WATCHDOG_POLICY.warmupSteps ||
      probe.activeSeconds < WATCHDOG_POLICY.warmupSeconds
    ) {
      this.suspend();
      return report("warming-up");
    }
    const key = `${checkpoint}:${size}:${protectionRevision}`;
    let entry = this.baselines.get(key);
    if (
      !entry ||
      entry.protectionRevision !== protectionRevision ||
      Math.abs(entry.coverage - probe.coverage) > 0.15
    ) {
      entry = {
        protectionRevision,
        coverage: probe.coverage,
        samples: [],
        baseline: null,
      };
      this.baselines.set(key, entry);
      this.suspend();
    }
    const healthyCandidate =
      probe.rgbContrast >= 0.002 &&
      probe.hiddenEnergy >= 0.005 &&
      probe.clipping < 0.05 &&
      probe.coverage >= 0.2;
    if (!entry.baseline) {
      if (!healthyCandidate || probe.hiddenDelta === null) {
        entry.samples = [];
        return report("uncertain");
      }
      entry.samples.push(probe);
      if (entry.samples.length < WATCHDOG_POLICY.baselineProbes)
        return report("learning");
      entry.baseline = Object.fromEntries(
        ["rgbContrast", "hiddenEnergy", "hiddenDelta", "clipping"].map(
          (name) => [name, median(entry.samples.map((sample) => sample[name]))],
        ),
      );
      entry.samples = [];
    }
    const base = entry.baseline;
    const collapsed =
      probe.rgbContrast < base.rgbContrast * 0.22 &&
      probe.hiddenEnergy < base.hiddenEnergy * 0.25 &&
      probe.hiddenDelta !== null &&
      probe.hiddenDelta < Math.max(0.0015, base.hiddenDelta * 0.25);
    const saturated =
      probe.clipping > 0.35 && probe.clipping > base.clipping + 0.25;
    if (!collapsed && !saturated) {
      this.suspend();
      // Stillness alone is diagnostic. Static, energetic textures stay healthy.
      return report(
        probe.hiddenDelta < 0.0015 && probe.rgbDelta < 0.0015
          ? "still"
          : "healthy",
      );
    }
    this.badCount++;
    if (this.badCount < WATCHDOG_POLICY.badProbes)
      return report("suspected-collapse");
    this.attempts = this.attempts.filter((time) => timestamp - time < 60000);
    if (
      timestamp - (this.attempts.at(-1) ?? -Infinity) <
        WATCHDOG_POLICY.cooldown ||
      this.attempts.length >= WATCHDOG_POLICY.attemptsPerMinute
    )
      return report("cooldown");
    return report("collapsed", {
      recover: Boolean(enabled),
      reason: saturated ? "clipping" : "collapse",
    });
  }
}
