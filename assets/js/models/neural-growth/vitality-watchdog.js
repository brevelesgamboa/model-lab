import { RECOVERY_POLICY } from "./audio-response.js";

export const WATCHDOG_POLICY = Object.freeze({
  warmupSteps: 96,
  warmupSeconds: 3,
  baselineProbes: 4,
  badProbes: 3,
  manualHold: 8000,
  cooldown: 10000,
  attemptsPerMinute: 2,
  observationUpdates: 192,
  minimumObservationUpdates: 64,
  successProbes: 2,
  // Local rescues restore part of the field; do not demand a full-grid reset.
  restoredContrastRatio: 0.3,
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

// Greedy farthest-point placement on the torus, with no overlapping rescues
// when the eligible area only has room for one spore.
export function selectRecoverySeeds(tiles, offset = 0) {
  if (!tiles.length) return [];
  const selected = [tiles[offset % tiles.length]];
  const distance = (a, b) => {
    const dx = Math.abs((a % INTENT_SIZE) - (b % INTENT_SIZE)) / INTENT_SIZE;
    const dy =
      Math.abs(Math.floor(a / INTENT_SIZE) - Math.floor(b / INTENT_SIZE)) /
      INTENT_SIZE;
    return Math.hypot(Math.min(dx, 1 - dx), Math.min(dy, 1 - dy));
  };
  while (selected.length < RECOVERY_POLICY.maximum) {
    let best = null,
      separation = RECOVERY_POLICY.radius * 2;
    for (const tile of tiles) {
      const nearest = Math.min(
        ...selected.map((other) => distance(tile, other)),
      );
      if (nearest > separation) {
        best = tile;
        separation = nearest;
      }
    }
    if (best === null) break;
    selected.push(best);
  }
  return selected;
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const BASELINE_FIELDS = [
  "rgbContrast",
  "nativeContrast",
  "nativeBrightness",
  "hiddenEnergy",
  "hiddenDelta",
  "clipping",
  "rgbClipping",
  "nativeBlackCoverage",
  "nativeWhiteCoverage",
];

// Relative loss from a trusted texture is essential: darkness and stillness on
// their own are normal states for some checkpoints, not recovery requests.
export function classifyVitality(probe, base, context = {}) {
  const motionKnown =
    Number.isFinite(probe.hiddenDelta) && Number.isFinite(probe.rgbDelta);
  const quietLatent =
    motionKnown &&
    probe.hiddenDelta < Math.max(0.0015, base.hiddenDelta * 0.25);
  const rawFlat = probe.rgbContrast < base.rgbContrast * 0.22;
  const nativeFlat =
    base.nativeContrast >= 0.01 &&
    Number.isFinite(probe.nativeContrast) &&
    probe.nativeContrast < Math.max(0.0005, base.nativeContrast * 0.12);
  const rgbSaturated =
    probe.rgbClipping > 0.8 &&
    probe.rgbClipping > (base.rgbClipping ?? 0) + 0.5 &&
    (rawFlat || nativeFlat);
  const saturated =
    rgbSaturated ||
    (probe.clipping > 0.35 && probe.clipping > base.clipping + 0.25);
  const latent =
    rawFlat && probe.hiddenEnergy < base.hiddenEnergy * 0.25 && quietLatent;
  const visible =
    nativeFlat &&
    quietLatent &&
    (probe.nativeDelta ?? probe.rgbDelta) !== null &&
    (probe.nativeDelta ?? probe.rgbDelta) < 0.0015 &&
    probe.rgbDelta < 0.0015 &&
    (rawFlat ||
      (context.nativeProjectionReliable !== false &&
        (probe.nativeBlackCoverage > 0.98 ||
          probe.nativeWhiteCoverage > 0.98)));
  const diagnosis = saturated
    ? "saturation"
    : latent
      ? "latent-collapse"
      : visible
        ? "visible-flat"
        : null;
  return {
    diagnosis,
    severe: diagnosis !== null,
    state: saturated
      ? "saturated"
      : diagnosis
        ? "collapsed"
        : !motionKnown
          ? "uncertain"
          : probe.hiddenDelta < 0.0015 && probe.rgbDelta < 0.0015
            ? "still"
            : "healthy",
  };
}

export class VitalityWatchdog {
  constructor() {
    this.baselines = new Map();
    this.attempts = [];
    this.manualUntil = -Infinity;
    this.generation = null;
    this.lastStep = -1;
    this.badCount = 0;
    this.assessment = { status: "learning", recover: false };
    this.counters = {
      admitted: 0,
      applied: 0,
      cancelled: 0,
      succeeded: 0,
      failed: 0,
    };
    this.pending = null;
    this.lastOutcome = null;
    this.recoveryRevision = 0;
  }
  suspend() {
    this.badCount = 0;
  }
  noteManualEdit(timestamp) {
    this.manualUntil = timestamp + WATCHDOG_POLICY.manualHold;
    if (this.pending)
      this.finishRecovery("cancelled", "manual-edit", timestamp);
    this.suspend();
    this.assessment = { status: "manual-hold", recover: false };
  }
  // Charged only after meaningful dispatch, never on queue admission.
  recordRecovery(timestamp) {
    this.attempts.push(timestamp);
    this.lastAppliedAttempt = timestamp;
    this.suspend();
  }
  admitRecovery(id, timestamp, context, probe) {
    this.lastAdmittedAttempt = timestamp;
    this.counters.admitted++;
    this.recoveryRevision++;
    const { entry } = this.baselineFor(context, probe);
    this.pending = {
      id,
      timestamp,
      checkpoint: context.checkpoint,
      size: context.size,
      generation: context.generation,
      test: context.test === true,
      diagnosis:
        context.diagnosis ??
        classifyVitality(probe, entry?.baseline ?? probe).diagnosis,
      phase: "queued",
      emittedDose: 0,
      applied: false,
      healthyProbes: 0,
      lastHealthyStep: -1,
      baseline: entry?.baseline ? { ...entry.baseline } : null,
    };
    this.suspend();
  }
  handleRecoveryEvent(event) {
    const pending = this.pending;
    if (!pending || pending.id !== event.attemptId) return;
    if (event.type === "cancelled") {
      this.finishRecovery("cancelled", event.reason, event.timestamp);
      return;
    }
    if (event.type === "dose") {
      pending.emittedDose += event.dose;
      if (
        !pending.applied &&
        pending.emittedDose >= RECOVERY_POLICY.meaningfulDose
      ) {
        pending.applied = true;
        pending.phase = "delivering";
        pending.appliedStep = event.steps;
        pending.appliedTimestamp = event.timestamp;
        this.recordRecovery(event.timestamp);
        this.counters.applied++;
      }
    }
    if (event.type === "delivered") {
      pending.phase = "observing";
      pending.completedStep = event.steps;
    }
    this.recoveryRevision++;
  }
  finishRecovery(status, reason, timestamp, probe = null) {
    if (!this.pending) return;
    this.counters[status]++;
    this.recoveryRevision++;
    this.lastOutcome = {
      ...this.pending,
      status,
      reason,
      finishedAt: timestamp,
      finishedStep: probe?.steps ?? null,
    };
    this.pending = null;
    this.suspend();
  }
  baselineFor({ checkpoint, size, protectionRevision = 0 }, probe) {
    const key = `${checkpoint}:${size}:${protectionRevision}`;
    const exact = this.baselines.get(key);
    if (exact?.baseline) return { key, sourceKey: key, entry: exact };
    // Geometry/manual generations do not invalidate learned checkpoint/grid
    // health. Similar eligible coverage can reuse a trusted protected scope.
    for (const [sourceKey, entry] of this.baselines) {
      if (
        sourceKey.startsWith(`${checkpoint}:${size}:`) &&
        entry.baseline &&
        probe &&
        Math.abs(entry.coverage - probe.coverage) <= 0.15
      )
        return { key, sourceKey, entry };
    }
    return { key, sourceKey: key, entry: exact };
  }
  limits(now) {
    const attempts = this.attempts.filter((time) => now - time < 60000);
    const cooldown = Math.max(
      0,
      (Math.max(
        attempts.at(-1) ?? -Infinity,
        this.pending?.timestamp ?? -Infinity,
      ) +
        WATCHDOG_POLICY.cooldown -
        now) /
        1000,
    );
    const cap =
      attempts.length >= WATCHDOG_POLICY.attemptsPerMinute
        ? Math.max(
            0,
            (attempts[attempts.length - WATCHDOG_POLICY.attemptsPerMinute] +
              60000 -
              now) /
              1000,
          )
        : 0;
    return { attempts, cooldown, cap };
  }
  // Cached projection only: never learns, advances evidence, or prunes limits.
  getDiagnostics(probe, context) {
    const {
      timestamp: now,
      generation,
      enabled,
      active = true,
      pointerDown = false,
      unavailable = false,
      eligibleSeeds = null,
      recovering = false,
    } = context;
    const current = probe?.generation === generation ? probe : null;
    const { key, sourceKey, entry } = this.baselineFor(context, current),
      base = entry?.baseline;
    const warming =
      !current ||
      current.steps < WATCHDOG_POLICY.warmupSteps ||
      current.activeSeconds < WATCHDOG_POLICY.warmupSeconds;
    const { attempts, cooldown, cap } = this.limits(now),
      blockerDetails = {};
    const add = (name, seconds = null) => {
      blockerDetails[name] = { remainingSeconds: seconds };
    };
    if (!enabled) add("recovery-off");
    if (pointerDown || now < this.manualUntil)
      add("manual-hold", Math.max(0, (this.manualUntil - now) / 1000));
    if (cooldown > 0) add("cooldown", cooldown);
    else if (this.pending) add("recovery-pending");
    if (cap > 0) add("rate-cap", cap);
    if (current?.coverage < 0.05) add("protected-region");
    if (!base) add("no-baseline");
    if (eligibleSeeds === 0 && current) add("no-eligible-seed");
    if (unavailable) add("probe-unavailable");
    if (
      !active ||
      !current ||
      now - current.timestamp > (context.size <= 256 ? 1500 : 3000)
    )
      add("paused-or-stale");
    const classification =
      current && base && !warming
        ? classifyVitality(current, base, context)
        : { state: warming ? "warming-up" : "uncertain", diagnosis: null };
    const activeBlockers = Object.keys(blockerDetails);
    return {
      state: unavailable
        ? "uncertain"
        : recovering || this.pending
          ? "recovering"
          : classification.state,
      diagnosis: this.pending?.diagnosis ?? classification.diagnosis,
      primaryBlocker: activeBlockers[0] ?? null,
      activeBlockers,
      blockerDetails,
      badCount: this.badCount,
      baseline: {
        status: warming
          ? "warming-up"
          : base
            ? "locked"
            : entry?.samples.length
              ? "learning"
              : "missing",
        key,
        sourceKey,
        sampleCount: base
          ? WATCHDOG_POLICY.baselineProbes
          : (entry?.samples.length ?? 0),
        requiredSamples: WATCHDOG_POLICY.baselineProbes,
        reference: base ? { ...base } : null,
        ratios: Object.fromEntries(
          BASELINE_FIELDS.map((name) => [
            name,
            current?.[name] != null && base?.[name] > 0
              ? current[name] / base[name]
              : null,
          ]),
        ),
        provenance: entry?.provenance
          ? {
              ...entry.provenance,
              geometry: entry.provenance.geometry
                ? { ...entry.provenance.geometry }
                : null,
            }
          : null,
      },
      lastAdmittedAttempt: this.lastAdmittedAttempt ?? null,
      attemptsRemaining: Math.max(
        0,
        WATCHDOG_POLICY.attemptsPerMinute - attempts.length,
      ),
      recoveryTracking: {
        counters: { ...this.counters },
        lastAppliedAttempt: this.lastAppliedAttempt ?? null,
        observation: this.pending
          ? {
              ...this.pending,
              baseline: this.pending.baseline
                ? { ...this.pending.baseline }
                : null,
              observedUpdates: Math.max(
                0,
                (current?.steps ?? 0) -
                  (this.pending.completedStep ?? Infinity),
              ),
              requiredUpdates: WATCHDOG_POLICY.observationUpdates,
            }
          : null,
        lastOutcome: this.lastOutcome
          ? {
              ...this.lastOutcome,
              baseline: this.lastOutcome.baseline
                ? { ...this.lastOutcome.baseline }
                : null,
            }
          : null,
      },
    };
  }
  observe(probe, context) {
    const {
      generation,
      timestamp,
      active = true,
      pointerDown = false,
      enabled = false,
      protectionRevision = 0,
      provenance = null,
    } = context;
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
    if (
      this.pending &&
      (this.pending.generation !== generation ||
        this.pending.checkpoint !== context.checkpoint ||
        this.pending.size !== context.size)
    )
      this.finishRecovery("cancelled", "state-changed", timestamp);
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
    let { key, entry } = this.baselineFor(context, probe);
    if (
      !entry ||
      (!entry.baseline && Math.abs(entry.coverage - probe.coverage) > 0.15)
    ) {
      entry = {
        protectionRevision,
        coverage: probe.coverage,
        samples: [],
        baseline: null,
      };
      this.baselines.set(key, entry);
    }
    if (!entry.baseline && !this.pending) {
      const healthy =
        probe.rgbContrast >= 0.003 &&
        probe.hiddenEnergy >= 0.005 &&
        probe.clipping < 0.35 &&
        probe.coverage >= 0.2;
      if (!healthy || probe.hiddenDelta === null) {
        entry.samples = [];
        return report("uncertain");
      }
      entry.samples.push(probe);
      if (entry.samples.length < WATCHDOG_POLICY.baselineProbes)
        return report("learning");
      entry.baseline = Object.fromEntries(
        BASELINE_FIELDS.filter((name) =>
          entry.samples.every((p) => Number.isFinite(p[name])),
        ).map((name) => [name, median(entry.samples.map((p) => p[name]))]),
      );
      entry.provenance = {
        checkpoint: context.checkpoint,
        size: context.size,
        generation,
        steps: probe.steps,
        timestamp,
        protectionRevision,
        geometry: provenance ? { ...provenance } : null,
      };
      entry.samples = [];
    }
    if (this.pending) {
      const p = this.pending;
      if (p.phase === "observing") {
        const elapsed = probe.steps - p.completedStep,
          base = p.baseline;
        const textured =
          probe.rgbContrast >=
            Math.max(
              0.003,
              (base?.rgbContrast ?? 0.01) *
                WATCHDOG_POLICY.restoredContrastRatio,
            ) &&
          (context.nativeProjectionReliable === false ||
            !Number.isFinite(probe.nativeContrast) ||
            probe.nativeContrast >=
              Math.max(
                0.005,
                (base?.nativeContrast ?? 0.01) *
                  WATCHDOG_POLICY.restoredContrastRatio,
              )) &&
          !(base && classifyVitality(probe, base, context).severe);
        if (
          elapsed >= WATCHDOG_POLICY.minimumObservationUpdates &&
          textured &&
          probe.steps - p.lastHealthyStep >= 24
        ) {
          p.healthyProbes++;
          p.lastHealthyStep = probe.steps;
        } else if (!textured) p.healthyProbes = 0;
        if (p.healthyProbes >= WATCHDOG_POLICY.successProbes)
          this.finishRecovery(
            "succeeded",
            "sustained-contrast",
            timestamp,
            probe,
          );
        else if (elapsed >= WATCHDOG_POLICY.observationUpdates)
          this.finishRecovery(
            "failed",
            "no-sustained-contrast",
            timestamp,
            probe,
          );
      }
      if (this.pending) return report("recovering", { diagnosis: p.diagnosis });
    }
    if (!entry.baseline) return report("uncertain");
    const classification = classifyVitality(probe, entry.baseline, context);
    if (!classification.severe) {
      this.suspend();
      const seedEligible =
        probe.rgbContrast >= entry.baseline.rgbContrast * 0.5 &&
        (!Number.isFinite(entry.baseline.nativeContrast) ||
          probe.nativeContrast >= entry.baseline.nativeContrast * 0.5);
      return report(classification.state, { diagnosis: null, seedEligible });
    }
    this.badCount++;
    if (this.badCount < WATCHDOG_POLICY.badProbes)
      return report("suspected-collapse", {
        diagnosis: classification.diagnosis,
      });
    const { cooldown, cap } = this.limits(timestamp);
    if (cooldown > 0)
      return report("cooldown", { diagnosis: classification.diagnosis });
    if (cap > 0)
      return report("rate-cap", { diagnosis: classification.diagnosis });
    return report("collapsed", {
      recover: Boolean(enabled),
      reason: classification.diagnosis,
      diagnosis: classification.diagnosis,
    });
  }
}
