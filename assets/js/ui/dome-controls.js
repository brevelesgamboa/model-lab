import { createNeuronExplorer } from "./neuron-explorer.js";
import { FEATURE_TARGETS } from "../models/inception-feature-map.js";
import { INCEPTION_LAYER_CHANNELS } from "../models/neural-growth/inception-layers.js";

export function createDomeNeuronControls(
  elements,
  model,
  isActive,
  canInteract,
  onParameterChange,
) {
  const {
    domeArchetypes: archetypes,
    domeBrowseNeurons: browseBtn,
    domeCustomNeuronControls: customControls,
    domeCustomLayer: layerSelect,
    domeCustomChDec: decBtn,
    domeCustomChInc: incBtn,
    domeCustomChInput: chInput,
    domeCustomChSlider: chSlider,
  } = elements;
  let explorer = null;

  if (layerSelect && layerSelect.options.length === 0) {
    for (const [layer, count] of Object.entries(INCEPTION_LAYER_CHANNELS)) {
      const opt = document.createElement("option");
      opt.value = layer;
      opt.textContent = `${layer} (${count} ch)`;
      layerSelect.append(opt);
    }
  }

  function getChannelLimits(layer) {
    const total = INCEPTION_LAYER_CHANNELS[layer] || 768;
    return { min: 0, max: total - 1 };
  }

  function syncCustomUI(layer, ch) {
    if (customControls) customControls.hidden = false;
    if (layerSelect) layerSelect.value = layer;
    const { min, max } = getChannelLimits(layer);
    const clampedCh = Math.max(min, Math.min(ch, max));
    if (chSlider) {
      chSlider.min = String(min);
      chSlider.max = String(max);
      chSlider.value = String(clampedCh);
    }
    if (chInput) {
      chInput.value = String(clampedCh);
    }
  }

  function hideCustomUI() {
    if (customControls) customControls.hidden = true;
  }

  function applyCustomNeuron(layer, ch, forceCustom = true) {
    if (!isActive() || !canInteract()) return;
    const { min, max } = getChannelLimits(layer);
    const clampedCh = Math.max(min, Math.min(ch, max));
    syncCustomUI(layer, clampedCh);
    syncCustomOption(layer, clampedCh, forceCustom);
    onParameterChange?.("featureTarget", -1);
    model.setNeuronTarget(layer, clampedCh, forceCustom);
  }

  function syncCustomOption(layer, ch, forceCustom = false) {
    if (!archetypes) return;
    const isCustom = forceCustom || Boolean(model._isCustomNeuron);
    let customOpt = archetypes.querySelector('option[value="-1"]');
    if (!customOpt) {
      customOpt = document.createElement("option");
      customOpt.value = "-1";
      archetypes.append(customOpt);
    }
    if (!isCustom) {
      const idx = FEATURE_TARGETS.findIndex(
        (t) => t.layer === layer && t.channel === ch,
      );
      if (idx >= 0) {
        archetypes.value = String(idx);
        customOpt.textContent = "Custom neuron target";
        hideCustomUI();
        return;
      }
    }
    const matched = model.neuronArchetypes?.find(
      (n) =>
        n.layer === layer && (n.channel === ch || (n.channel < 0 && ch === 0)),
    );
    customOpt.textContent = matched
      ? `Custom: ${matched.name} (${layer} · #${ch})`
      : `Custom: ${layer} · #${ch}`;
    archetypes.value = "-1";
    syncCustomUI(layer, ch);
  }

  archetypes?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const idx = Number(archetypes.value);
    if (idx >= 0 && FEATURE_TARGETS[idx]) {
      hideCustomUI();
      const target = FEATURE_TARGETS[idx];
      onParameterChange?.("featureTarget", idx);
      model.setNeuronTarget(target.layer, target.channel, false);
    } else if (idx === -1) {
      const curLayer = model.selectedLayer || "mixed_5b";
      const curChannel = model.selectedChannel ?? 120;
      applyCustomNeuron(curLayer, curChannel, true);
    }
  });

  layerSelect?.addEventListener("change", () => {
    const layer = layerSelect.value;
    const ch = Number(chInput?.value) || 0;
    applyCustomNeuron(layer, ch);
  });

  chSlider?.addEventListener("input", () => {
    const layer = layerSelect?.value || model.selectedLayer || "mixed_5b";
    const ch = Number(chSlider.value);
    applyCustomNeuron(layer, ch);
  });

  chInput?.addEventListener("change", () => {
    const layer = layerSelect?.value || model.selectedLayer || "mixed_5b";
    const ch = Number(chInput.value);
    applyCustomNeuron(layer, ch);
  });

  decBtn?.addEventListener("click", () => {
    const layer = layerSelect?.value || model.selectedLayer || "mixed_5b";
    const ch = (Number(chInput?.value) || 0) - 1;
    applyCustomNeuron(layer, ch);
  });

  incBtn?.addEventListener("click", () => {
    const layer = layerSelect?.value || model.selectedLayer || "mixed_5b";
    const ch = (Number(chInput?.value) || 0) + 1;
    applyCustomNeuron(layer, ch);
  });

  browseBtn?.addEventListener("click", () => {
    if (!isActive() || !canInteract()) return;
    model.dreamBridge?.activatePreviews?.();
    if (!explorer) {
      explorer = createNeuronExplorer({
        parameters: {
          targetLayer: model.selectedLayer,
          targetChannel: model.selectedChannel,
        },
        neurons: model.neuronArchetypes || [],
        previewBridge: model.dreamBridge,
        onSelect(neuron) {
          if (!isActive() || !canInteract()) return;
          const ch = neuron.channel < 0 ? 0 : neuron.channel;
          syncCustomOption(neuron.layer, ch, true);
          onParameterChange?.("featureTarget", -1);
          model.setNeuronTarget(neuron.layer, ch, true);
        },
      });
    }
    explorer.update({
      targetLayer: model.selectedLayer,
      targetChannel: model.selectedChannel,
    });
    explorer.open({
      inspectTarget: {
        layer: model.selectedLayer,
        channel: model.selectedChannel,
      },
    });
  });

  if (archetypes && model._isCustomNeuron) {
    syncCustomOption(model.selectedLayer, model.selectedChannel, true);
  } else if (archetypes && model.selectedTarget >= 0) {
    archetypes.value = String(model.selectedTarget);
    hideCustomUI();
  } else if (archetypes && model.selectedTarget === -1) {
    syncCustomOption(model.selectedLayer, model.selectedChannel, true);
  }

  function update() {
    if (!archetypes) return;
    if (model._isCustomNeuron) {
      syncCustomOption(model.selectedLayer, model.selectedChannel, true);
      return;
    }
    const idx = model.selectedTarget;
    if (idx >= 0) {
      if (Number(archetypes.value) !== idx) {
        archetypes.value = String(idx);
      }
      hideCustomUI();
    } else if (model.selectedLayer && model.selectedChannel !== undefined) {
      syncCustomOption(model.selectedLayer, model.selectedChannel, true);
    }
  }

  return {
    update,
    dispose() {
      explorer?.dispose();
      explorer = null;
    },
  };
}

export function createDomeOutpaintingControls(
  elements,
  model,
  isActive,
  canInteract,
) {
  const {
    domeOutpainting: select,
    domeMiganCard: card,
    domeMiganFile: file,
    domeMiganStatus: status,
    domeMiganCancel: cancel,
    domeMiganBusy: busy,
    domeMiganNotice: notice,
  } = elements;
  function update() {
    const loading = model.inpaintState === "loading",
      missing = model.inpaintState === "missing";
    select.value =
      loading || missing || model.outpaintingMode === "migan"
        ? "migan"
        : "mirrored";
    card.hidden = !missing;
    busy.hidden = !loading;
    select.disabled = loading;
    const ready = model.inpaintState === "ready";
    status.classList.toggle("is-ready", ready);
    status.textContent = ready
      ? `MI-GAN Ready (${model.inpaintInfo.backend}${model.inpaintInfo.cached ? " / Cached" : " / This tab"})`
      : "Mirrored Wrap Active";
    notice.textContent = model.inpaintNotice || "";
    cancel.hidden = !loading && !missing;
  }
  select.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    model.cancelDream();
    if (select.value === "mirrored") model.useMirrored();
    else void model.prepareInpainting();
  });
  const load = (selected) => {
    if (selected && isActive() && canInteract())
      void model.prepareInpainting(selected);
  };
  file.addEventListener("change", () => {
    const selected = file.files?.[0];
    file.value = "";
    load(selected);
  });
  file.addEventListener("cancel", () => {
    if (model.inpaintState === "missing")
      model.useMirrored("File selection cancelled · Mirrored Wrap active");
  });
  cancel.addEventListener("click", () =>
    model.useMirrored("MI-GAN cancelled · Mirrored Wrap active"),
  );
  card.addEventListener("dragover", (event) => event.preventDefault());
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    load(event.dataTransfer?.files?.[0]);
  });
  return { update };
}
