// DOM-only diagnostics. Rendering and probe cadence remain owned by the model.
export function createGrowthVitalityHud({ panel, getModel, render }) {
  if (!panel) return { update() {}, dispose() {} };
  let enabled =
    new URLSearchParams(window.location.search).get("growthDebug") === "1";
  let timer = null,
    polling = null,
    previousModel = null,
    revision = null,
    lastRefresh = -Infinity;
  const nodes = new Map(
    [...panel.querySelectorAll("[data-vitality-field]")].map((node) => [
      node.dataset.vitalityField,
      node,
    ]),
  );
  const rawToggle = panel.querySelector("[data-vitality-raw]");
  const write = (key, text) => {
    const node = nodes.get(key);
    if (node && node.textContent !== text) node.textContent = text;
  };
  const number = (value) =>
    Number.isFinite(value) ? value.toFixed(5) : "unavailable";
  const json = (value) => JSON.stringify(value, null, 2);

  function refresh(force = false) {
    const model = getModel();
    if (!model || panel.hidden || !panel.open || document.hidden) return;
    const now = performance.now();
    if (!force && now - lastRefresh < 250) return;
    lastRefresh = now;
    const d = model.getVitalityDiagnostics(now),
      p = d.probe;
    // Only countdown/age nodes change between telemetry arrivals.
    write(
      "countdowns",
      d.activeBlockers
        .map((name) => {
          const seconds = d.blockerDetails[name].remainingSeconds;
          return `${name}${seconds === null ? "" : ` (${seconds.toFixed(1)}s)`}`;
        })
        .join(" · ") || "none",
    );
    write(
      "age",
      p
        ? `${(p.ageMs / 1000).toFixed(1)}s old · step ${p.steps} · generation ${p.generation}`
        : "No cached probe",
    );
    write(
      "lifetime",
      d.recovery.spores
        .map((spore) => `${spore.remainingUpdates} updates`)
        .join(" / ") || "No active spores",
    );
    write("remaining-dose", number(d.recovery.remainingEnvelopeDose));
    if (revision === d.revision) return;
    revision = d.revision;
    write("state", `${d.state} · bad probes ${d.badCount}/3`);
    write("diagnosis", d.diagnosis || "none");
    write("primary", d.primaryBlocker || "none");
    write(
      "rgb",
      p
        ? `${number(p.rgbContrast)} / ${number(p.rgbEnergy)} / ${number(p.rgbDelta)}`
        : "unavailable",
    );
    write(
      "native",
      p
        ? `${number(p.nativeContrast)} / ${number(p.nativeBrightness)} / ${number(p.nativeDelta)}`
        : "unavailable",
    );
    write(
      "rgb-clipping",
      p
        ? [p.rgbClipping, p.nativeBlackCoverage, p.nativeWhiteCoverage]
            .map((value) =>
              Number.isFinite(value)
                ? `${(value * 100).toFixed(2)}%`
                : "unavailable",
            )
            .join(" / ")
        : "unavailable",
    );
    const counts = d.recovery.counters;
    write(
      "outcomes",
      counts
        ? `${counts.admitted} admitted · ${counts.applied} applied · ${counts.cancelled} cancelled · ${counts.succeeded} succeeded · ${counts.failed} failed`
        : "unavailable",
    );
    const observation = d.recovery.observation;
    write(
      "observation",
      observation
        ? `${observation.phase} · ${observation.observedUpdates}/${observation.requiredUpdates} updates · ${observation.healthyProbes} healthy probes`
        : d.recovery.lastOutcome
          ? `${d.recovery.lastOutcome.status}: ${d.recovery.lastOutcome.reason}`
          : "No attempt yet",
    );
    write(
      "hidden",
      p
        ? `${number(p.hiddenEnergy)} / ${number(p.hiddenDelta)}`
        : "unavailable",
    );
    write(
      "coverage",
      p
        ? `${p.clippingPercent.toFixed(2)}% / ${p.eligibleCoveragePercent.toFixed(2)}%`
        : "unavailable",
    );
    write(
      "probe",
      p
        ? `${p.timestamp.toFixed(1)}ms · ${p.forced ? "forced diagnostic" : "production"}`
        : d.probeError || "Waiting for a probe",
    );
    write(
      "baseline",
      `${d.baseline.status} · ${d.baseline.sampleCount}/${d.baseline.requiredSamples} · ${d.baseline.key}`,
    );
    write(
      "reference",
      json({
        reference: d.baseline.reference,
        ratios: d.baseline.ratios,
        provenance: d.baseline.provenance,
      }),
    );
    write(
      "recovery",
      `${d.recovery.activeSpores} active · ${d.recovery.attemptsRemaining}/2 attempts available · last admitted ${d.recovery.lastAdmittedAttempt ?? "never"}`,
    );
    write(
      "dose",
      `${number(d.recovery.emittedDose)} emitted · ${number(d.recovery.rateCeiling)}/update per-spore peak`,
    );
    write(
      "spores",
      json(
        d.recovery.spores.map(({ x, y, radius, mode, emittedDose }) => ({
          x,
          y,
          radius,
          mode,
          emittedDose,
        })),
      ),
    );
    write("cancellation", d.recovery.lastCancellationReason || "none");
    write("actions", json(d.actions));
    write("geometry", json(d.geometry));
    write("display", json(d.display));
    rawToggle.checked = d.display.rawStateView;
  }

  function update() {
    const model = getModel();
    if (previousModel && previousModel !== model)
      previousModel.setRawStateView(false);
    if (previousModel !== model) revision = null;
    previousModel = model;
    panel.hidden = !model || !enabled;
    if (!panel.hidden && panel.open) {
      if (!timer) timer = window.setInterval(refresh, 250);
      refresh();
    } else {
      if (timer) window.clearInterval(timer);
      timer = null;
      if (model) model.setRawStateView(false);
      rawToggle.checked = false;
    }
  }
  function keydown(event) {
    if (
      !getModel() ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.key.toLowerCase() !== "d" ||
      event.target?.closest?.(
        "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
      )
    )
      return;
    event.preventDefault();
    enabled = !enabled;
    if (enabled) panel.open = true;
    update();
    render();
  }
  function toggled() {
    update();
    render();
  }
  function click(event) {
    const model = getModel();
    if (!model) return;
    const force = event.target.closest("[data-vitality-force]");
    const spore = event.target.closest("[data-vitality-spore]");
    if (!force && !spore) return;
    if (force) {
      model.forceVitalityProbe();
      const poll = () => {
        polling = null;
        if (getModel() !== model) return;
        model.pollVitalityDiagnostics();
        refresh(true);
        if (
          model.getVitalityDiagnostics().actions.forceProbe.status === "pending"
        )
          polling = requestAnimationFrame(poll);
      };
      if (!polling) polling = requestAnimationFrame(poll);
    }
    if (spore) model.testRecoverySpore();
    refresh(true);
  }
  function rawChanged() {
    getModel()?.setRawStateView(rawToggle.checked);
    render();
    refresh(true);
  }
  panel.open = enabled;
  panel.addEventListener("toggle", toggled);
  panel.addEventListener("click", click);
  rawToggle.addEventListener("change", rawChanged);
  document.addEventListener("keydown", keydown);
  return {
    update,
    dispose() {
      if (timer) window.clearInterval(timer);
      if (polling) cancelAnimationFrame(polling);
      previousModel?.setRawStateView(false);
      panel.removeEventListener("toggle", toggled);
      panel.removeEventListener("click", click);
      rawToggle.removeEventListener("change", rawChanged);
      document.removeEventListener("keydown", keydown);
    },
  };
}
