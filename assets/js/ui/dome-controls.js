import { createNeuronExplorer } from "./neuron-explorer.js";
import { FEATURE_TARGETS } from "../models/inception-feature-map.js";

export function createDomeNeuronControls(
  elements,
  model,
  isActive,
  canInteract,
  onParameterChange,
) {
  const { domeArchetypes: archetypes, domeBrowseNeurons: browseBtn } = elements;
  let explorer = null;

  function syncCustomOption(layer, ch) {
    if (!archetypes) return;
    const idx = FEATURE_TARGETS.findIndex(
      (t) => t.layer === layer && t.channel === ch,
    );
    let customOpt = archetypes.querySelector('option[value="-1"]');
    if (!customOpt) {
      customOpt = document.createElement("option");
      customOpt.value = "-1";
      archetypes.append(customOpt);
    }
    if (idx >= 0) {
      archetypes.value = String(idx);
      customOpt.hidden = true;
      customOpt.setAttribute("hidden", "");
    } else {
      const matched = model.neuronArchetypes?.find(
        (n) =>
          n.layer === layer && (n.channel === ch || (n.channel < 0 && ch === 0)),
      );
      customOpt.textContent = matched
        ? `Custom: ${matched.name} (${layer} · #${ch})`
        : `Custom: ${layer} · #${ch}`;
      customOpt.hidden = false;
      customOpt.removeAttribute("hidden");
      archetypes.value = "-1";
    }
  }

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
          const idx = FEATURE_TARGETS.findIndex(
            (t) => t.layer === neuron.layer && t.channel === ch,
          );
          const targetVal = idx >= 0 ? idx : -1;
          syncCustomOption(neuron.layer, ch);
          onParameterChange?.("featureTarget", targetVal);
          model.setNeuronTarget(neuron.layer, ch);
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

  archetypes?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const idx = Number(archetypes.value);
    if (idx >= 0 && FEATURE_TARGETS[idx]) {
      const target = FEATURE_TARGETS[idx];
      const customOpt = archetypes.querySelector('option[value="-1"]');
      if (customOpt) customOpt.hidden = true;
      onParameterChange?.("featureTarget", idx);
      model.setNeuronTarget(target.layer, target.channel);
    }
  });

  if (archetypes && model.selectedTarget >= 0) {
    archetypes.value = String(model.selectedTarget);
  } else if (archetypes && model.selectedTarget === -1) {
    syncCustomOption(model.selectedLayer, model.selectedChannel);
  }

  function update() {
    const idx = model.selectedTarget;
    if (!archetypes) return;
    if (idx >= 0) {
      if (Number(archetypes.value) !== idx) {
        archetypes.value = String(idx);
      }
      const customOpt = archetypes.querySelector('option[value="-1"]');
      if (customOpt) customOpt.hidden = true;
    } else if (model.selectedLayer && model.selectedChannel !== undefined) {
      syncCustomOption(model.selectedLayer, model.selectedChannel);
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
