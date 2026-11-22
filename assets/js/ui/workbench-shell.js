import {
  LFO_WAVEFORMS,
  lfoSignalAt,
  rateFromPosition,
  positionFromRate,
} from "../core/lfo.js";
import { rhythmController } from "../core/rhythm-controller.js";
import { inceptionSensor } from "../models/neural-growth/inception-sensor.js";
import { INCEPTION_LAYER_CHANNELS } from "../models/neural-growth/inception-layers.js";
import { createNeuronPreview } from "./neuron-preview.js";

export function setBrushRailVisible(rail, acceptsBrushInput) {
  if (!rail) return;
  rail.hidden = !acceptsBrushInput;
  rail.classList.toggle("hidden", !acceptsBrushInput);
}

export function updateRangeProgress(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const progress =
    max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty(
    "--range-progress",
    `${Math.max(0, Math.min(100, progress))}%`,
  );
}

export function updateBrushPreview(input) {
  const preview = document.getElementById("brush-diameter-preview");
  if (!preview || !input) return;
  preview.style.setProperty(
    "--brush-preview-size",
    `${Math.max(14, Math.min(24, Math.sqrt(Number(input.value)) * 3.5))}px`,
  );
  preview.title = `${Number(input.value) * 2}px diameter`;
}

export function initializeWorkbenchShell(elements) {
  document.addEventListener("input", (event) => {
    if (event.target.matches('input[type="range"]'))
      updateRangeProgress(event.target);
  });
  document.querySelectorAll('input[type="range"]').forEach(updateRangeProgress);
  document.addEventListener("click", (event) => {
    const brush = event.target.closest(".growth-brush-btn");
    if (!brush) return;
    if (["dye", "freeze", "thaw"].includes(brush.dataset.brush)) {
      document.getElementById("brush-settings").open = true;
    }
  });
  elements.growthBrushRadius?.addEventListener("input", () => {
    updateBrushPreview(elements.growthBrushRadius);
  });
}

// Drawer controls reuse the existing engine; they never create an analyser.
export function createModulationDrawer({
  definition,
  supportsLfo,
  previewBridge,
  onBrowseSensor,
  getLfoConfig,
  getAudioRoute,
  onLfoChange,
  onAudioSource,
  onAudioDepth,
}) {
  const element = document.createElement("section");
  element.className = "modulation-drawer";
  element.setAttribute("aria-label", `${definition.label} modulation drawer`);
  element.innerHTML = `
    <div class="drawer-wave-controls">
      <select data-field="waveform"></select>
      <label class="drawer-enable"><input type="checkbox" data-field="enabled"><span>On</span></label>
      <select data-field="polarity" title="Modulation direction"><option value="bipolar">±</option><option value="positive">+</option><option value="negative">−</option></select>
      <label class="drawer-amount"><input type="number" data-field="depth" min="0" max="100" step="1"><span>%</span></label>
    </div>
    <svg class="drawer-waveform" viewBox="0 0 256 78" preserveAspectRatio="none" role="img">
      <path d="M0 19.5H256M0 39H256M0 58.5H256M64 0V78M128 0V78M192 0V78" fill="none" stroke="#222630" stroke-width=".6"/>
      <path class="drawer-curve" fill="none" stroke="#38bdf8" stroke-width="1.6"/>
      <line class="drawer-playhead" x1="0" x2="0" y1="0" y2="78" stroke="#f4f4f6" stroke-width=".7" opacity=".65"/>
      <circle class="drawer-playhead-dot" cx="0" cy="39" r="2.5" fill="#38bdf8"/>
    </svg>
    <div class="drawer-rate"><label>Rate<input data-field="rate" type="range" min="0" max="1" step="0.001"></label><label class="drawer-hz"><input data-field="rateHz" type="number" min="0.005" max="8" step="0.005"><span>Hz</span></label><select data-field="rateRange"><option value="slow">Slow</option><option value="full">Full</option></select></div>
    <label class="drawer-range">Phase<input data-field="phase" type="range" min="0" max="360" step="1"><output></output></label>
    <div class="drawer-audio">
      <div class="drawer-audio-head"><span>Signal</span><div class="drawer-segments" role="group"><button type="button" data-source="bass" aria-pressed="false">Full</button><button type="button" data-source="kick" aria-pressed="false"><span class="drawer-kick-led" aria-hidden="true"></span>Kick</button><button type="button" data-source="inception" aria-pressed="false">Inception</button><button type="button" data-source="none" aria-pressed="true">Off</button></div></div>
      <div class="drawer-audio-depth"><label class="drawer-range">Depth<input data-field="audioDepth" type="range" min="0" max="1" step="0.01"><output></output></label><div class="drawer-segments drawer-audio-polarity" role="group"><button type="button" data-audio-polarity="-1" aria-pressed="false">−</button><button type="button" data-audio-polarity="1" aria-pressed="true">+</button></div></div>
      <div class="drawer-sensor" hidden>
        <details class="drawer-sensor-help">
          <summary aria-label="Explain the Inception sensor"><span>Neuron sensor</span><span class="parameter-info-button" aria-hidden="true">?</span></summary>
          <div>
            <p>Watches the canvas and uses one neuron's response to move this parameter. Depth sets how much.</p>
            <p>The preview shows patterns that excite that neuron. Layer chooses a network stage; Channel chooses a neuron.</p>
            <p>The graph shows its relative response over 30 seconds. Higher means more activity.</p>
            <a href="https://distill.pub/2017/feature-visualization/" target="_blank" rel="noopener noreferrer">Read Feature Visualization ↗</a>
          </div>
        </details>
        <label>Feature layer<select data-field="sensorLayer"></select></label>
        <label>Channel<input data-field="sensorChannel" type="number" min="0" max="191" step="1"></label>
        <div data-sensor-preview></div>
        <button type="button" class="mini-button" data-browse-sensor>Browse neuron gallery</button>
        <p>One neuron shared by all Inception routes. Samples the canvas twice per second.</p>
        <div class="drawer-sensor-state"><span data-sensor-status aria-live="polite"></span><button type="button" data-sensor-retry hidden>Retry</button></div>
        <figure class="sensor-activity">
          <figcaption><span>Activity</span><span>Last 30 seconds</span></figcaption>
          <svg data-sensor-activity viewBox="0 0 240 52" role="img" aria-label="Recent neuron activity, smoothed relative response from low to high">
            <path class="sensor-activity-grid" d="M4 4H236M4 26H236M4 48H236"/>
            <path class="sensor-activity-line"/>
            <circle class="sensor-activity-dot" r="2" hidden/>
            <text x="120" y="29" text-anchor="middle" data-sensor-activity-empty>Waiting for readings…</text>
          </svg>
        </figure>
      </div>
    </div>
    <details class="drawer-global-settings"><summary>Global audio settings</summary>
      <label class="drawer-range">Input gain<input data-field="inputGain" type="range" min="0.1" max="3" step="0.01"><output></output></label>
      <label class="drawer-range">Threshold<input data-field="kickOffset" type="range" min="0" max="0.25" step="0.005"><output></output></label>
      <label class="drawer-range">Kick gate<input data-field="kickGate" type="range" min="0" max="0.2" step="0.005"><output></output></label>
    </details>
    <div class="drawer-value"><span>Value</span><output></output></div>`;
  const fields = new Map();
  const labels = {
    waveform: "waveform",
    enabled: "modulation enabled",
    polarity: "modulation direction",
    depth: "LFO depth percent",
    rate: "LFO rate",
    rateHz: "LFO rate in Hz",
    rateRange: "LFO rate range",
    phase: "LFO phase",
    audioDepth: "audio modulation depth",
    inputGain: "global input gain",
    kickOffset: "global kick threshold",
    kickGate: "global kick gate",
    sensorLayer: "sensor layer",
    sensorChannel: "sensor channel",
  };
  for (const input of element.querySelectorAll("[data-field]")) {
    const key = input.dataset.field;
    fields.set(key, input);
    input.setAttribute("aria-label", `${definition.label} ${labels[key]}`);
    if (
      [
        "waveform",
        "enabled",
        "polarity",
        "depth",
        "rate",
        "rateHz",
        "rateRange",
        "phase",
      ].includes(key)
    )
      input.disabled = !supportsLfo;
  }
  for (const entry of LFO_WAVEFORMS) {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label[0] + entry.label.slice(1).toLowerCase();
    fields.get("waveform").append(option);
  }
  for (const [layer, channels] of Object.entries(INCEPTION_LAYER_CHANNELS)) {
    const option = document.createElement("option");
    option.value = layer;
    option.textContent = `${layer} · ${channels}`;
    fields.get("sensorLayer").append(option);
  }
  let sensorPreview = null;
  let activityHistory = null;
  const activityLine = element.querySelector(".sensor-activity-line");
  const activityDot = element.querySelector(".sensor-activity-dot");
  const activityEmpty = element.querySelector("[data-sensor-activity-empty]");
  function syncActivity() {
    const history = inceptionSensor.getHistory();
    if (history === activityHistory) return;
    activityHistory = history;
    const last = history.at(-1);
    const start = (last?.timestamp || 0) - 30_000;
    const points = history.map(({ timestamp, level }) => [
      4 + ((timestamp - start) / 30_000) * 232,
      48 - level * 44,
    ]);
    activityLine.setAttribute(
      "d",
      points
        .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`)
        .join(" "),
    );
    activityDot.toggleAttribute("hidden", !last);
    activityEmpty.toggleAttribute("hidden", Boolean(last));
    if (last) {
      activityDot.setAttribute("cx", "236");
      activityDot.setAttribute("cy", String(48 - last.level * 44));
    }
  }
  const browseSensor = element.querySelector("[data-browse-sensor]");
  browseSensor.hidden = !onBrowseSensor;
  browseSensor.addEventListener("click", () => onBrowseSensor?.());
  function syncSensor() {
    const target = inceptionSensor.getTarget();
    const parameters = {
      targetLayer: target.layer,
      targetChannel: target.channel,
    };
    if (previewBridge && !sensorPreview) {
      sensorPreview = createNeuronPreview({
        parameters,
        previewBridge,
        className: "sensor-neuron-preview",
        description:
          "Optimized feature example. The sensor measures this channel on your live canvas.",
      });
      element
        .querySelector("[data-sensor-preview]")
        .append(sensorPreview.element);
      void previewBridge.loadPreviews();
    }
    sensorPreview?.update(parameters);
    const stats = inceptionSensor.getStats();
    syncActivity();
    const channelInput = fields.get("sensorChannel");
    fields.get("sensorLayer").value = target.layer;
    channelInput.max = String(INCEPTION_LAYER_CHANNELS[target.layer] - 1);
    if (document.activeElement !== channelInput)
      channelInput.value = String(target.channel);
    const status = element.querySelector("[data-sensor-status]");
    const text =
      stats.status === "error"
        ? stats.error
        : !stats.active
          ? "Paused"
          : stats.status === "loading"
            ? "Loading Inception…"
            : stats.samples < 2
              ? "Calibrating…"
              : `Neural energy ${Math.round(stats.level * 100)}%`;
    if (status.textContent !== text) status.textContent = text;
    element.querySelector("[data-sensor-retry]").hidden =
      stats.status !== "error";
  }
  fields.get("sensorLayer").addEventListener("change", (event) => {
    inceptionSensor.setTarget(
      event.target.value,
      inceptionSensor.getTarget().channel,
    );
    fields.get("sensorChannel").value = String(
      inceptionSensor.getTarget().channel,
    );
    syncSensor();
  });
  fields.get("sensorChannel").addEventListener("change", (event) => {
    if (event.target.value !== "")
      inceptionSensor.setTarget(
        inceptionSensor.getTarget().layer,
        Number(event.target.value),
      );
    event.target.value = String(inceptionSensor.getTarget().channel);
    syncSensor();
  });
  element.querySelector("[data-sensor-retry]").addEventListener("click", () => {
    inceptionSensor.stop();
    inceptionSensor.start();
    syncSensor();
  });
  const svg = element.querySelector("svg");
  svg.setAttribute("aria-label", `${definition.label} LFO curve and playhead`);
  element
    .querySelector(".drawer-segments")
    .setAttribute("aria-label", `${definition.label} audio mode`);
  const sourceButtons = element.querySelectorAll("button[data-source]");
  const polarityButtons = element.querySelectorAll("[data-audio-polarity]");
  element
    .querySelector(".drawer-audio-polarity")
    .setAttribute("aria-label", `${definition.label} audio depth direction`);
  for (const button of polarityButtons) {
    const negative = button.dataset.audioPolarity === "-1";
    button.setAttribute(
      "aria-label",
      `${definition.label} audio depth ${negative ? "below" : "above"} base`,
    );
    button.title = negative
      ? "Audio lowers the value"
      : "Audio raises the value";
  }
  let audioPolarity = getAudioRoute().depth < 0 ? -1 : 1;
  const audio = element.querySelector(".drawer-audio");
  const curve = element.querySelector(".drawer-curve");
  const playhead = element.querySelector(".drawer-playhead");
  const dot = element.querySelector(".drawer-playhead-dot");
  const valueOutput = element.querySelector(".drawer-value output");
  const valueRow = element.querySelector(".drawer-value");
  let latestFrame = null;
  const showBreakdown = () => {
    if (!latestFrame) return;
    const frame = latestFrame;
    valueRow.title = `Base ${frame.baseValue.toFixed(2)} · LFO ${(frame.oscillatorValue - frame.baseValue).toFixed(2)} · ${frame.audioSource === "inception" ? "Inception" : "Audio"} ${(frame.audioValue - frame.oscillatorValue).toFixed(2)}`;
  };
  valueRow.tabIndex = 0;
  valueRow.addEventListener("pointerenter", showBreakdown);
  valueRow.addEventListener("focus", showBreakdown);
  const kickLed = element.querySelector(".drawer-kick-led");
  let previousShape = "";
  let fullRange = Number(getLfoConfig().rate) > 0.5;
  const rateMaximum = () => (fullRange ? 8 : 0.5);
  function setValue(key, value) {
    const input = fields.get(key);
    if (input.value !== String(value)) input.value = String(value);
    if (input.type === "range") updateRangeProgress(input);
  }
  function syncRange(key, value, text) {
    setValue(key, value);
    const output = fields.get(key).nextElementSibling;
    if (output.textContent !== text) output.textContent = text;
  }
  function sync() {
    const config = getLfoConfig();
    const route = getAudioRoute();
    setValue("waveform", config.waveform);
    fields.get("enabled").checked = Boolean(config.enabled);
    fields.get("enabled").nextElementSibling.textContent = config.enabled
      ? "On"
      : "Off";
    svg.style.opacity = config.enabled ? "1" : ".45";
    setValue("polarity", config.polarity || "bipolar");
    setValue("depth", Math.round(config.depth * 100));
    if (config.rate > 0.5) fullRange = true;
    setValue("rateRange", fullRange ? "full" : "slow");
    setValue("rate", positionFromRate(config.rate, rateMaximum()));
    setValue("rateHz", Number(Number(config.rate).toFixed(3)));
    fields
      .get("rate")
      .setAttribute("aria-valuetext", `${Number(config.rate).toFixed(3)} Hz`);
    syncRange(
      "phase",
      Math.round(config.phase * 360),
      `${Math.round(config.phase * 360)}°`,
    );
    if (route.depth !== 0) audioPolarity = route.depth < 0 ? -1 : 1;
    syncRange(
      "audioDepth",
      Math.abs(route.depth),
      `${Math.round(route.depth * 100)}%`,
    );
    fields.get("audioDepth").disabled = route.source === "none";
    for (const button of polarityButtons) {
      button.disabled = route.source === "none";
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.audioPolarity) === audioPolarity),
      );
    }
    audio.dataset.source = route.source;
    element.querySelector(".drawer-sensor").hidden =
      route.source !== "inception";
    element.querySelector(".drawer-global-settings").hidden =
      route.source === "inception";
    if (route.source === "inception") syncSensor();
    for (const button of sourceButtons)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.source === route.source),
      );
    const shape = `${config.waveform}:${config.polarity || "bipolar"}`;
    if (shape !== previousShape) {
      let path = "";
      for (let index = 0; index <= 128; index++) {
        const phase = index / 128;
        path += `${index ? "L" : "M"}${phase * 256} ${(39 - lfoSignalAt(config, phase) * 30).toFixed(2)}`;
      }
      curve.setAttribute("d", path);
      previousShape = shape;
    }
  }
  function syncSettings() {
    syncRange(
      "inputGain",
      rhythmController.inputGain,
      `${rhythmController.inputGain.toFixed(2)}×`,
    );
    syncRange(
      "kickOffset",
      rhythmController.kickOffset,
      rhythmController.kickOffset.toFixed(3),
    );
    syncRange(
      "kickGate",
      rhythmController.kickGate,
      rhythmController.kickGate.toFixed(3),
    );
  }
  for (const key of ["waveform", "polarity"])
    fields
      .get(key)
      .addEventListener("change", () =>
        onLfoChange(key, fields.get(key).value),
      );
  fields
    .get("enabled")
    .addEventListener("change", (event) =>
      onLfoChange("enabled", event.target.checked),
    );
  fields.get("depth").addEventListener("input", (event) => {
    if (event.target.value !== "")
      onLfoChange(
        "depth",
        Math.max(0, Math.min(1, Number(event.target.value) / 100)),
      );
  });
  fields
    .get("rate")
    .addEventListener("input", (event) =>
      onLfoChange(
        "rate",
        Number(
          rateFromPosition(Number(event.target.value), rateMaximum()).toFixed(
            4,
          ),
        ),
      ),
    );
  fields.get("rateHz").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (event.target.value !== "" && Number.isFinite(value))
      onLfoChange("rate", Math.max(0.005, Math.min(8, value)));
    else sync();
  });
  fields.get("rateRange").addEventListener("change", (event) => {
    fullRange = event.target.value === "full";
    if (!fullRange && getLfoConfig().rate > 0.5) onLfoChange("rate", 0.5);
    else sync();
  });
  fields
    .get("phase")
    .addEventListener("input", (event) =>
      onLfoChange("phase", Number(event.target.value) / 360),
    );
  fields
    .get("audioDepth")
    .addEventListener("input", (event) =>
      onAudioDepth(audioPolarity * Number(event.target.value)),
    );
  for (const button of polarityButtons) {
    button.addEventListener("click", () => {
      audioPolarity = Number(button.dataset.audioPolarity);
      onAudioDepth(audioPolarity * Math.abs(getAudioRoute().depth));
    });
  }
  for (const [key, setter] of [
    ["inputGain", "setInputGain"],
    ["kickOffset", "setKickOffset"],
    ["kickGate", "setKickGate"],
  ])
    fields
      .get(key)
      .addEventListener("input", (event) =>
        rhythmController[setter](event.target.value),
      );
  for (const button of sourceButtons)
    button.addEventListener("click", () =>
      onAudioSource(button.dataset.source),
    );
  let lastValue = "";
  let lastPosition = "";
  let lastHeight = "";
  let lastKickActive = false;
  function updateKick(active) {
    if (active === lastKickActive) return;
    kickLed.classList.toggle("is-active", active);
    lastKickActive = active;
  }
  function updateFrame(frame, kickActive) {
    if (element.closest("[hidden], details:not([open])")) return;
    if (getAudioRoute().source === "inception") syncSensor();
    latestFrame = frame;
    const text = frame.effectiveValue.toFixed(2);
    if (text !== lastValue) {
      valueOutput.textContent = text;
      lastValue = text;
    }
    const x = (frame.lfoPhase * 256).toFixed(2);
    const y = (39 - frame.lfoSignal * 30).toFixed(2);
    if (x !== lastPosition) {
      playhead.setAttribute("x1", x);
      playhead.setAttribute("x2", x);
      dot.setAttribute("cx", x);
      lastPosition = x;
    }
    if (y !== lastHeight) {
      dot.setAttribute("cy", y);
      lastHeight = y;
    }
    updateKick(kickActive);
  }
  sync();
  syncSettings();
  return {
    element,
    sync,
    syncSettings,
    updateFrame,
    updateKick,
    dispose: () => sensorPreview?.dispose(),
  };
}

export function bindModulationStrip({
  track,
  definition,
  getConfig,
  getBase,
  onChange,
}) {
  track.setAttribute("role", "slider");
  track.tabIndex = 0;
  track.setAttribute("aria-label", `${definition.label} LFO amount`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.title =
    "Drag to adjust LFO depth. Arrow keys adjust the amount; Shift makes smaller changes.";
  let pointer = null;
  let originX = 0;
  let originDepth = 0;
  let width = 1;
  let direction = 1;
  const setDepth = (value) =>
    onChange({ depth: Math.max(0, Math.min(1, value)), enabled: true });
  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointer !== null) return;
    event.preventDefault();
    const bounds = track.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    const config = getConfig();
    const base =
      (Number(getBase()) - definition.min) / (definition.max - definition.min);
    const handle = event.target.closest(".modulation-track__handle");
    direction =
      config.polarity === "negative" ||
      (config.polarity !== "positive" &&
        (handle?.classList.contains("modulation-track__handle--start") ||
          (!handle && event.clientX < bounds.left + base * width)))
        ? -1
        : 1;
    if (!handle)
      setDepth(((event.clientX - bounds.left) / width - base) * 2 * direction);
    originX = event.clientX;
    originDepth = getConfig().depth;
    pointer = event.pointerId;
    track.setPointerCapture(pointer);
    track.focus({ preventScroll: true });
    track.classList.add("is-dragging");
  });
  track.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointer)
      setDepth(
        originDepth + ((event.clientX - originX) / width) * 2 * direction,
      );
  });
  const release = (event) => {
    if (event.pointerId !== pointer) return;
    if (track.hasPointerCapture(pointer)) track.releasePointerCapture(pointer);
    pointer = null;
    track.classList.remove("is-dragging");
  };
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    track.addEventListener(name, release);
  track.addEventListener("keydown", (event) => {
    const delta = event.shiftKey ? 0.01 : 0.05;
    const depth = getConfig().depth;
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowUp")
      next = depth + delta;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown")
      next = depth - delta;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    else return;
    event.preventDefault();
    setDepth(next);
  });
  return function sync() {
    const config = getConfig();
    const amount = Math.round(config.depth * 100);
    track.setAttribute("aria-valuenow", String(amount));
    track.setAttribute(
      "aria-valuetext",
      `${amount}%, ${config.polarity === "positive" ? "above base" : config.polarity === "negative" ? "below base" : "both directions"}`,
    );
    track.dataset.polarity = config.polarity || "bipolar";
    track.dataset.enabled = String(Boolean(config.enabled));
  };
}
