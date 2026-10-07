import { LFO_WAVEFORMS } from "../core/lfo.js";
import {
  AUDIO_MODULATION_SOURCES,
  getAudioRoute,
  setAudioRoute,
} from "../core/modulation-matrix.js";
import { clamp } from "../core/utils.js";

export function modulationIsActive(config, audioRoute) {
  return Boolean(config?.enabled || audioRoute?.source !== "none");
}

export function makeModulationPanel({
  definition,
  config,
  supportsLfo,
  modelId,
  getVisibleBase,
  coerceRangeValue,
  onCaptureBase,
  onChange,
}) {
  let audioRoute = getAudioRoute(modelId, definition.key);
  const panel = document.createElement("div");
  panel.className = "modulation-panel";
  panel.hidden = !modulationIsActive(config, audioRoute);

  const header = document.createElement("div");
  header.className = "modulation-panel__header";
  const title = document.createElement("strong");
  title.textContent = "MODULATION PANEL";
  const lfoEnable = document.createElement("label");
  lfoEnable.className = "modulation-panel__enable";
  lfoEnable.hidden = !supportsLfo;
  const lfoCheckbox = document.createElement("input");
  lfoCheckbox.type = "checkbox";
  lfoCheckbox.checked = Boolean(config.enabled);
  lfoCheckbox.setAttribute("aria-label", `Enable ${definition.label} LFO`);
  lfoEnable.append(lfoCheckbox, document.createTextNode("LFO ENABLED"));
  header.append(title, lfoEnable);

  const lfoControls = document.createElement("div");
  lfoControls.className = "modulation-panel__lfo";
  lfoControls.hidden = !supportsLfo;

  const top = document.createElement("div");
  top.className = "modulation-panel__top";
  const waveformField = document.createElement("label");
  waveformField.append(document.createTextNode("LFO WAVE"));
  const waveformSelect = document.createElement("select");
  LFO_WAVEFORMS.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    waveformSelect.append(option);
  });
  waveformSelect.value = config.waveform;
  waveformField.append(waveformSelect);

  const note = document.createElement("label");
  note.append(document.createTextNode("SIGNAL"));
  const noteValue = document.createElement("input");
  noteValue.type = "text";
  noteValue.value = "BASE + LFO + AUDIO";
  noteValue.disabled = true;
  note.append(noteValue);
  top.append(waveformField, note);

  const numericDefinitions = [
    ["RATE HZ", "rate", 0.005, 8, 0.005],
    ["LFO DEPTH", "depth", 0, 1, 0.005],
    ["PHASE", "phase", 0, 1, 0.001],
  ];

  const updateConfig = () => {
    audioRoute = setAudioRoute(modelId, definition.key, audioRoute);
    const active = modulationIsActive(config, audioRoute);
    onChange({ config, audioRoute, active });
  };

  const fields = numericDefinitions.map(([labelText, key, min, max, step]) => {
    const field = document.createElement("label");
    field.className = "modulation-field";
    const label = document.createElement("span");
    label.textContent = labelText;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(config[key]);
    const number = document.createElement("input");
    number.type = "number";
    number.min = String(min);
    number.max = String(max);
    number.step = String(step);
    number.value = String(config[key]);

    const setValue = (value) => {
      const next = clamp(Number(value), min, max);
      config[key] = next;
      slider.value = String(next);
      number.value = String(next);
      updateConfig();
    };
    slider.addEventListener("input", () => setValue(slider.value));
    number.addEventListener("input", () => {
      if (number.value === "" || !Number.isFinite(Number(number.value))) return;
      setValue(number.value);
    });
    field.append(label, slider, number);
    return field;
  });

  lfoCheckbox.addEventListener("change", () => {
    config.enabled = lfoCheckbox.checked;
    updateConfig();
  });
  waveformSelect.addEventListener("change", () => {
    config.waveform = waveformSelect.value;
    updateConfig();
  });

  const visualizerWrap = document.createElement("div");
  visualizerWrap.className = "modulation-visualizer-wrap";
  const visualizerLabel = document.createElement("span");
  visualizerLabel.textContent =
    "LIVE 4S · GRAY BASE / PURPLE LFO / CYAN OUTPUT / AMBER KICK";
  const visualizer = document.createElement("canvas");
  visualizer.className = "modulation-visualizer";
  visualizer.setAttribute(
    "aria-label",
    `${definition.label} live modulation history: base, LFO, audio, and effective output`,
  );
  visualizerWrap.append(visualizerLabel, visualizer);
  lfoControls.append(top, ...fields);

  const audioControls = document.createElement("div");
  audioControls.className = "modulation-panel__audio";
  const audioSourceField = document.createElement("label");
  audioSourceField.className = "modulation-source";
  const audioSourceLabel = document.createElement("span");
  audioSourceLabel.textContent = "AUDIO SOURCE";
  const audioSource = document.createElement("select");
  audioSource.setAttribute("aria-label", `${definition.label} audio source`);
  AUDIO_MODULATION_SOURCES.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    audioSource.append(option);
  });
  audioSource.value = audioRoute.source;
  audioSourceField.append(audioSourceLabel, audioSource);

  const audioDepthField = document.createElement("label");
  audioDepthField.className = "modulation-field";
  const audioDepthLabel = document.createElement("span");
  audioDepthLabel.textContent = "AUDIO DEPTH";
  const audioDepth = document.createElement("input");
  audioDepth.type = "range";
  audioDepth.min = "-1";
  audioDepth.max = "1";
  audioDepth.step = "0.01";
  audioDepth.value = String(audioRoute.depth);
  const audioDepthNumber = document.createElement("input");
  audioDepthNumber.type = "number";
  audioDepthNumber.min = "-1";
  audioDepthNumber.max = "1";
  audioDepthNumber.step = "0.01";
  audioDepthNumber.value = String(audioRoute.depth);

  const syncAudioAvailability = () => {
    const disabled = audioRoute.source === "none";
    audioDepth.disabled = disabled;
    audioDepthNumber.disabled = disabled;
  };
  const setAudioDepth = (value) => {
    const next = clamp(Number(value), -1, 1);
    audioRoute.depth = next;
    audioDepth.value = String(next);
    audioDepthNumber.value = String(next);
    updateConfig();
  };

  audioSource.addEventListener("change", () => {
    audioRoute.source = audioSource.value;
    if (audioRoute.source !== "none") {
      const visibleBase = Number(getVisibleBase());
      if (Number.isFinite(visibleBase)) {
        onCaptureBase(coerceRangeValue(definition, visibleBase));
      }
    }
    syncAudioAvailability();
    updateConfig();
  });
  audioDepth.addEventListener("input", () => setAudioDepth(audioDepth.value));
  audioDepthNumber.addEventListener("input", () => {
    if (
      audioDepthNumber.value === "" ||
      !Number.isFinite(Number(audioDepthNumber.value))
    )
      return;
    setAudioDepth(audioDepthNumber.value);
  });
  audioDepthField.append(audioDepthLabel, audioDepth, audioDepthNumber);
  audioControls.append(audioSourceField, audioDepthField);
  syncAudioAvailability();

  panel.append(header, lfoControls, audioControls, visualizerWrap);
  return { panel, visualizer };
}
