import { clamp, randomSeed } from "../core/utils.js";
import { defaultLfoConfig } from "../core/lfo.js";
import { getAudioRoute } from "../core/modulation-matrix.js";
import { supportsModulation } from "../core/model-contract.js";
import { modulationIsActive } from "../ui/modulation-panel.js";

export function formatControlValue(definition, value) {
  const numeric = Number(value);
  switch (definition.format) {
    case "percent":
      return `${Math.round(numeric * 100)}%`;
    case "degrees":
      return `${Math.round(numeric)} deg`;
    case "decimal1":
      return numeric.toFixed(1);
    case "decimal2":
      return numeric.toFixed(2);
    case "decimal3":
      return numeric.toFixed(3);
    case "integer":
      return String(Math.round(numeric));
    default:
      return Number.isFinite(numeric) ? String(numeric) : String(value);
  }
}

export function precisionFromStep(step) {
  const text = String(step);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

export function coerceRangeValue(definition, value) {
  let numeric = Number(value);
  if (definition.wrap) {
    const span = Number(definition.max) - Number(definition.min);
    if (span > 0) {
      numeric =
        ((((numeric - Number(definition.min)) % span) + span) % span) +
        Number(definition.min);
    }
  } else {
    numeric = clamp(
      numeric,
      Number(definition.min),
      Number(definition.max),
    );
  }
  if (definition.format === "integer" || Number(definition.step) >= 1)
    return Math.round(numeric);
  return Number(
    numeric.toFixed(
      Math.max(precisionFromStep(definition.fineStep || definition.step), 4),
    ),
  );
}

export function renderModelTechnicalInfo(elements, model) {
  const info = model?.technicalInfo;

  if (!elements.modelInfo || !elements.modelInfoContent) return;

  if (!info) {
    elements.modelInfo.hidden = true;
    elements.modelInfoContent.replaceChildren();
    return;
  }

  elements.modelInfo.hidden = false;
  elements.modelInfoContent.replaceChildren();

  const addSection = (title) => {
    const heading = document.createElement("div");
    heading.className = "model-info__section";
    heading.textContent = title;
    elements.modelInfoContent.appendChild(heading);
  };

  const addRow = (label, value) => {
    if (value === undefined || value === null || value === "") return;

    const row = document.createElement("div");
    row.className = "model-info__row";

    const labelElement = document.createElement("span");
    labelElement.className = "model-info__label";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");
    valueElement.className = "model-info__value";
    valueElement.textContent = String(value);

    row.append(labelElement, valueElement);
    elements.modelInfoContent.appendChild(row);
  };

  addRow("MODEL", info.title);
  addRow("ARCHITECTURE", info.architecture);
  addRow("TRAINING SET", info.trainingSet);
  addRow("DATASET IDENTITIES", info.datasetIdentities);
  addRow("DATASET IMAGES", info.datasetImages);
  addRow("TRAINING RESOLUTION", info.trainingResolution);
  addRow("LATENT DIMENSIONS", info.latentDimensions);
  addRow("EPOCHS", info.epochs);

  addRow("TARGET LAYERS", info.targetLayers);
  addRow("OBJECTIVE", info.objective);
  addRow("OCTAVE SCHEDULE", info.octaveSchedule);
  addRow("REFERENCE", info.reference);
  addRow("LICENSE", info.license);
  if (info.provenanceUrl) {
    const link = document.createElement("a");
    link.href = info.provenanceUrl;
    link.textContent = "Checkpoint attribution and license";
    link.target = "_blank";
    link.rel = "noopener";
    elements.modelInfoContent.append(link);
  }
  if (info.trainingFramework || info.trainingHardware) addSection("TRAINING");
  addRow("FRAMEWORK", info.trainingFramework);
  addRow("HARDWARE", info.trainingHardware);

  addSection("INFERENCE");
  addRow("FRAMEWORK", info.inferenceFramework);
  addRow("SUPPORTED BACKEND", info.inferenceBackend);
  addRow("INPUT", info.browserInput);
  addRow("OUTPUT", info.browserOutput);
}

export function createControlsController({
  elements,
  controlElements,
  getModel,
  getParameters,
  getLfoState,
  onPreset,
  onRange,
  onValue,
  onInfo,
  makeModulationPanel,
  onModulationOpen,
}) {
  let presetSelect = null;
  function makeLabel(definition) {
    const wrapper = document.createElement("span");
    wrapper.className = "control-label-wrap";
    const label = document.createElement("span");
    label.className = "control-label";
    label.textContent = definition.label;
    const info = document.createElement("button");
    info.type = "button";
    info.className = "parameter-info-button";
    info.textContent = "?";
    info.title = `Explain ${definition.label} in the session log`;
    info.setAttribute("aria-label", `Explain ${definition.label}`);
    info.addEventListener("click", () => onInfo(definition));
    wrapper.append(label, info);
    return wrapper;
  }
  function renderPresetControl() {
    const presets = getModel().presets || [];
    if (!presets.length) return;

    const field = document.createElement("label");
    field.className = "preset-control";
    const label = document.createElement("span");
    label.textContent = "PRESET";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Visual preset");

    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = "CUSTOM";
    select.append(custom);
    presets.forEach((preset) => {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = preset.name;
      select.append(option);
    });

    select.addEventListener("change", () => {
      const preset = presets.find((entry) => entry.name === select.value);
      if (!preset) return;
      onPreset(preset);
    });

    field.append(label, select);
    elements.parameterControls.append(field);
    presetSelect = select;
  }

  function createGuidanceElement(definition, initialValue) {
    const container = document.createElement("div");
    container.className = "control-guidance";
    const tag = document.createElement("span");
    tag.className = "control-guidance__tag";
    const text = document.createElement("span");
    text.className = "control-guidance__text";
    container.append(tag, text);

    function resolveGuidance(value) {
      if (typeof definition.getGuidance === "function") {
        return definition.getGuidance(value);
      }
      if (definition.type === "select" && Array.isArray(definition.options)) {
        const match = definition.options.find(
          (opt) => String(opt.value) === String(value),
        );
        if (match && (match.compute || match.guidance)) {
          return {
            compute: match.compute || "neutral",
            tag: match.tag || match.compute,
            text: match.guidance || "",
          };
        }
      }
      if (definition.compute || definition.guidance) {
        return {
          compute: definition.compute || "neutral",
          tag: definition.tag || definition.compute,
          text: definition.guidance || "",
        };
      }
      return null;
    }

    function update(value) {
      const info = resolveGuidance(value);
      if (!info || !info.text) {
        container.hidden = true;
        return;
      }
      container.hidden = false;
      const compute = String(info.compute || "neutral").toLowerCase();
      tag.className = `control-guidance__tag control-guidance__tag--${compute}`;
      tag.textContent = String(info.tag || compute).toUpperCase();
      text.textContent = info.text;
    }

    update(initialValue);
    const info = resolveGuidance(initialValue);
    if (!info || !info.text) {
      container.hidden = true;
    }

    return { container, update };
  }

  function render() {
    const currentModel = getModel();
    const currentParameters = getParameters();
    const currentLfoState = getLfoState();
    elements.parameterControls.replaceChildren();
    controlElements.clear();
    presetSelect = null;

    renderPresetControl();

    currentModel.controls.forEach((definition) => {
      const block = document.createElement("div");
      block.className = "control-block";

      if (definition.type === "range") {
        const head = document.createElement("div");
        head.className = "control-head";
        const label = makeLabel(definition);

        const fineGroup = document.createElement("div");
        fineGroup.className = "control-fine-group";
        const fineStep = Number(definition.fineStep || definition.step || 0.01);
        const minus = document.createElement("button");
        minus.type = "button";
        minus.className = "nudge-button";
        minus.textContent = "-";
        minus.title = `Decrease by ${fineStep}`;
        const fine = document.createElement("input");
        fine.className = "fine-input";
        fine.type = "number";
        fine.min = String(definition.min);
        fine.max = String(definition.max);
        fine.step = String(fineStep);
        fine.value = String(currentParameters[definition.key]);
        fine.setAttribute("aria-label", `${definition.label} exact value`);
        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "nudge-button";
        plus.textContent = "+";
        plus.title = `Increase by ${fineStep}`;
        fineGroup.append(minus, fine, plus);
        head.append(label, fineGroup);

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "control-slider";
        slider.min = String(definition.min);
        slider.max = String(definition.max);
        slider.step = String(definition.step);
        slider.value = String(currentParameters[definition.key]);
        slider.setAttribute("aria-label", definition.label);

        const modulationTrack = document.createElement("div");
        modulationTrack.className = "modulation-track";
        modulationTrack.setAttribute("aria-hidden", "true");
        const modulationRange = document.createElement("span");
        modulationRange.className = "modulation-track__range";
        const baseMarker = document.createElement("span");
        baseMarker.className = "modulation-track__base";
        const effectiveMarker = document.createElement("span");
        effectiveMarker.className = "modulation-track__effective";
        modulationTrack.append(modulationRange, baseMarker, effectiveMarker);

        const footer = document.createElement("div");
        footer.className = "control-footer";
        const effectiveLabel = document.createElement("span");
        effectiveLabel.className = "control-effective";
        effectiveLabel.textContent = `VALUE ${formatControlValue(definition, currentParameters[definition.key])}`;
        const modulationToggle = document.createElement("button");
        modulationToggle.type = "button";
        modulationToggle.className = "modulation-toggle";
        modulationToggle.dataset.key = definition.key;
        modulationToggle.setAttribute(
          "aria-label",
          `Toggle modulation for ${definition.label}`,
        );
        modulationToggle.textContent = "MOD";
        const config = currentLfoState[definition.key] || defaultLfoConfig();
        currentLfoState[definition.key] = config;
        const audioRoute = getAudioRoute(currentModel.id, definition.key);
        const supportsLfo =
          supportsModulation(currentModel, definition) &&
          currentModel.supportsLfo !== false;
        const active = modulationIsActive(config, audioRoute);
        modulationToggle.classList.toggle("is-active", active);
        modulationToggle.setAttribute("aria-pressed", String(active));
        footer.append(effectiveLabel, modulationToggle);

        const guidance = createGuidanceElement(
          definition,
          currentParameters[definition.key],
        );

        const modulation = makeModulationPanel(definition, config, supportsLfo);
        const canModulate = supportsModulation(currentModel, definition);
        modulationToggle.hidden = !canModulate;
        modulationTrack.hidden = !canModulate;
        modulation.panel.hidden = !canModulate || modulation.panel.hidden;
        modulationToggle.setAttribute(
          "aria-expanded",
          String(!modulation.panel.hidden),
        );
        block.append(
          head,
          slider,
          modulationTrack,
          footer,
          guidance.container,
          modulation.panel,
        );

        const update = (value) => {
          onRange(definition, value);
          guidance.update(value);
        };
        slider.addEventListener("input", () => update(slider.value));
        fine.addEventListener("input", () => {
          if (fine.value === "" || !Number.isFinite(Number(fine.value))) return;
          update(fine.value);
        });
        minus.addEventListener("click", () =>
          update(Number(getParameters()[definition.key]) - fineStep),
        );
        plus.addEventListener("click", () =>
          update(Number(getParameters()[definition.key]) + fineStep),
        );
        modulationToggle.addEventListener("click", () => {
          modulation.panel.hidden = !modulation.panel.hidden;
          modulationToggle.setAttribute(
            "aria-expanded",
            String(!modulation.panel.hidden),
          );
          if (!modulation.panel.hidden) {
            onModulationOpen();
          }
        });

        controlElements.set(definition.key, {
          definition,
          slider,
          fine,
          effectiveLabel,
          guidance,
          modulationToggle,
          modulationPanel: modulation.panel,
          modulationVisualizer: modulation.visualizer,
          modulationTrack,
          modulationRange,
          baseMarker,
          effectiveMarker,
        });
      } else if (definition.type === "select") {
        block.classList.add("select-control");
        const label = makeLabel(definition);
        const select = document.createElement("select");
        select.setAttribute("aria-label", definition.label);
        definition.options.forEach((entry) => {
          const option = document.createElement("option");
          option.value = String(entry.value);
          option.textContent = entry.label;
          select.append(option);
        });
        select.value = String(currentParameters[definition.key]);
        const guidance = createGuidanceElement(
          definition,
          currentParameters[definition.key],
        );
        select.addEventListener("change", () => {
          const match = definition.options.find(
            (entry) => String(entry.value) === select.value,
          );
          const val = match ? match.value : select.value;
          onValue(definition, val);
          guidance.update(val);
        });
        block.append(label, select, guidance.container);
        controlElements.set(definition.key, { definition, select, guidance });
      } else if (definition.type === "color") {
        block.classList.add("color-control");
        const label = makeLabel(definition);

        const presetsContainer = document.createElement("div");
        presetsContainer.className = "color-control__presets";
        const presets = definition.presets || [
          { label: "Cyan", value: "#00f0ff" },
          { label: "Magenta", value: "#ff00a0" },
          { label: "Gold", value: "#ffb800" },
          { label: "Lime", value: "#00ff66" },
          { label: "Violet", value: "#9d4edd" },
          { label: "White", value: "#ffffff" },
        ];

        const inputRow = document.createElement("div");
        inputRow.className = "color-control__input-row";

        const pickerInput = document.createElement("input");
        pickerInput.type = "color";
        pickerInput.className = "color-picker-input";
        pickerInput.setAttribute(
          "aria-label",
          `${definition.label} color picker`,
        );

        const hexInput = document.createElement("input");
        hexInput.type = "text";
        hexInput.className = "color-hex-input";
        hexInput.maxLength = 7;
        hexInput.spellcheck = false;
        hexInput.setAttribute("aria-label", `${definition.label} hex value`);

        const guidance = createGuidanceElement(
          definition,
          currentParameters[definition.key],
        );

        const normalizeHex = (val) => {
          let s = String(val || "#00f0ff").trim();
          if (!s.startsWith("#")) s = "#" + s;
          return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : "#00f0ff";
        };

        const updateActivePreset = (currentVal) => {
          const norm = normalizeHex(currentVal);
          presetsContainer
            .querySelectorAll(".color-preset-pill")
            .forEach((pill) => {
              const pillVal = pill.getAttribute("data-color");
              pill.classList.toggle("is-active", pillVal === norm);
            });
        };

        const setColor = (val) => {
          const norm = normalizeHex(val);
          pickerInput.value = norm;
          hexInput.value = norm.toUpperCase();
          updateActivePreset(norm);
          onValue(definition, norm);
          guidance.update(norm);
        };

        presets.forEach((preset) => {
          const pill = document.createElement("button");
          pill.type = "button";
          pill.className = "color-preset-pill";
          pill.setAttribute("data-color", preset.value.toLowerCase());
          const dot = document.createElement("span");
          dot.className = "color-preset-dot";
          dot.style.backgroundColor = preset.value;
          const text = document.createElement("span");
          text.textContent = preset.label;
          pill.append(dot, text);
          pill.addEventListener("click", () => setColor(preset.value));
          presetsContainer.append(pill);
        });

        pickerInput.addEventListener("input", () => setColor(pickerInput.value));

        hexInput.addEventListener("change", () => {
          const norm = normalizeHex(hexInput.value);
          setColor(norm);
        });

        const initialVal = normalizeHex(currentParameters[definition.key]);
        pickerInput.value = initialVal;
        hexInput.value = initialVal.toUpperCase();
        updateActivePreset(initialVal);

        inputRow.append(pickerInput, hexInput);
        block.append(label, presetsContainer, inputRow, guidance.container);
        controlElements.set(definition.key, {
          definition,
          pickerInput,
          hexInput,
          guidance,
          updateActivePreset,
        });
      } else {
        block.classList.add("number-control");
        const label = makeLabel(definition);
        const inline = document.createElement("div");
        inline.className = "number-control__inline";
        const input = document.createElement("input");
        input.type = "number";
        input.min = String(definition.min);
        input.max = String(definition.max);
        input.step = String(definition.step);
        input.value = String(currentParameters[definition.key]);
        input.setAttribute("aria-label", definition.label);
        const guidance = createGuidanceElement(
          definition,
          currentParameters[definition.key],
        );
        input.addEventListener("input", () => {
          if (input.value === "" || !Number.isFinite(Number(input.value)))
            return;
          const val = coerceRangeValue(definition, input.value);
          onValue(definition, val);
          guidance.update(val);
        });
        inline.append(input);
        if (definition.key === "seed") {
          const random = document.createElement("button");
          random.type = "button";
          random.className = "mini-button";
          random.textContent = "RND";
          random.addEventListener("click", () => {
            input.value = String(randomSeed());
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
          inline.append(random);
        }
        block.append(label, inline, guidance.container);
        controlElements.set(definition.key, { definition, input, guidance });
      }

      if (definition.help) {
        const help = document.createElement("small");
        help.className = "field__help";
        help.textContent = definition.help;
        block.append(help);
      }
      elements.parameterControls.append(block);
    });
  }

  return {
    render,
    setPreset: (name) => {
      if (presetSelect) presetSelect.value = name;
    },
  };
}
