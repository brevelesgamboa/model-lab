import { createNeuronGallery } from "./neuron-gallery.js";
import {
  INCEPTION_LAYER_CHANNELS,
  getInceptionLayerChannels,
} from "../models/neural-growth/inception-layers.js";
import { FEATURE_TARGETS } from "../models/inception-feature-map.js";

export function createDomeNeuronControls(
  elements,
  model,
  isActive,
  canInteract,
) {
  const {
    domeNeuronGalleryMount: mount,
    domeArchetypes: archetypes,
    domeManualChannelPanel: manualPanel,
    domeNeuronLayer: layerSelect,
    domeNeuronChannelSlider: channelSlider,
    domeNeuronChannelNumber: channelNumber,
    domeNeuronChannelPrev: channelPrev,
    domeNeuronChannelNext: channelNext,
    domeNeuronChannelMax: channelMax,
    domeNeuronRandom: randomBtn,
  } = elements;

  if (layerSelect && layerSelect.options.length === 0) {
    for (const [layer, count] of Object.entries(INCEPTION_LAYER_CHANNELS)) {
      const opt = document.createElement("option");
      opt.value = layer;
      opt.textContent = `${layer} (${count} ch)`;
      layerSelect.append(opt);
    }
  }

  function syncChannelBounds(layer) {
    const max = getInceptionLayerChannels(layer);
    if (channelSlider) channelSlider.max = String(max - 1);
    if (channelNumber) channelNumber.max = String(max - 1);
    if (channelMax) channelMax.textContent = `/ ${max - 1}`;
    return max;
  }

  function syncCustomTarget(layer, ch) {
    const idx = FEATURE_TARGETS.findIndex(
      (t) => t.layer === layer && t.channel === ch,
    );
    const paramSelect = elements.parameterControls?.querySelector(
      '.control-block[data-parameter="featureTarget"] select',
    );
    for (const sel of [archetypes, paramSelect]) {
      if (!sel) continue;
      let customOpt = sel.querySelector('option[value="-1"]');
      if (!customOpt) {
        customOpt = document.createElement("option");
        customOpt.value = "-1";
        sel.append(customOpt);
      }
      if (idx >= 0) {
        sel.value = String(idx);
        customOpt.hidden = true;
      } else {
        const matched = model.neuronArchetypes?.find(
          (n) =>
            n.layer === layer && (n.channel === ch || (n.channel < 0 && ch === 0)),
        );
        customOpt.textContent = matched
          ? `Custom: ${matched.name} (${layer} · #${ch})`
          : `Custom: ${layer} · #${ch}`;
        customOpt.hidden = false;
        sel.value = "-1";
      }
    }
    if (paramSelect) {
      const targetVal = String(idx >= 0 ? idx : -1);
      if (paramSelect.value !== targetVal) {
        paramSelect.value = targetVal;
      }
    }
  }

  const triggerActivation = () => {
    model.dreamBridge?.activatePreviews?.();
  };
  mount?.addEventListener("pointerenter", triggerActivation, { once: true });
  mount?.addEventListener("focusin", triggerActivation, { once: true });
  mount?.addEventListener("click", triggerActivation, { once: true });

  const gallery =
    mount && model.neuronArchetypes
      ? createNeuronGallery({
          neurons: model.neuronArchetypes,
          parameters: {
            targetLayer: model.selectedLayer,
            targetChannel: model.selectedChannel,
            dreamStrength: 0.2,
          },
          previewBridge: model.dreamBridge,
          showStrip: false,
          onSelect(neuron) {
            if (!isActive() || !canInteract()) return;
            const ch = neuron.channel < 0 ? 0 : neuron.channel;
            if (layerSelect) layerSelect.value = neuron.layer;
            syncChannelBounds(neuron.layer);
            if (channelSlider) channelSlider.value = String(ch);
            if (channelNumber) channelNumber.value = String(ch);
            model.setNeuronTarget(neuron.layer, ch);
            syncCustomTarget(neuron.layer, ch);
            if (gallery) {
              gallery.update(
                { targetLayer: neuron.layer, targetChannel: ch, dreamStrength: 0.2 },
                {},
              );
            }
            const idx = FEATURE_TARGETS.findIndex(
              (t) => t.layer === neuron.layer && t.channel === ch,
            );
            const paramSelect = elements.parameterControls?.querySelector(
              '.control-block[data-parameter="featureTarget"] select',
            );
            if (paramSelect && paramSelect.value !== String(idx >= 0 ? idx : -1)) {
              paramSelect.value = String(idx >= 0 ? idx : -1);
              paramSelect.dispatchEvent(new Event("change", { bubbles: true }));
            }
          },
          manualOpen: false,
          onToggleManual(open) {
            if (manualPanel) manualPanel.hidden = !open;
          },
        })
      : null;

  if (gallery && mount) {
    mount.replaceChildren(gallery.element);
  }

  let channelDebounce = null;
  const commitChannel = (layer, ch) => {
    if (!isActive() || !canInteract()) return;
    model.setNeuronTarget(layer, ch);
    syncCustomTarget(layer, ch);
    if (gallery) {
      gallery.update(
        { targetLayer: layer, targetChannel: ch, dreamStrength: 0.2 },
        {},
      );
    }
    const idx = FEATURE_TARGETS.findIndex(
      (t) => t.layer === layer && t.channel === ch,
    );
    const paramSelect = elements.parameterControls?.querySelector(
      '.control-block[data-parameter="featureTarget"] select',
    );
    if (paramSelect && paramSelect.value !== String(idx >= 0 ? idx : -1)) {
      paramSelect.value = String(idx >= 0 ? idx : -1);
      paramSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const onChannelInput = (value, immediate = false) => {
    if (!isActive() || !canInteract()) return;
    const layer = layerSelect?.value || model.selectedLayer;
    const max = getInceptionLayerChannels(layer);
    const ch = Math.max(0, Math.min(Number(value) || 0, max - 1));
    if (channelSlider && Number(channelSlider.value) !== ch) {
      channelSlider.value = String(ch);
    }
    if (channelNumber && Number(channelNumber.value) !== ch) {
      channelNumber.value = String(ch);
    }
    syncCustomTarget(layer, ch);
    if (gallery) {
      gallery.update(
        { targetLayer: layer, targetChannel: ch, dreamStrength: 0.2 },
        {},
      );
    }
    clearTimeout(channelDebounce);
    if (immediate) {
      commitChannel(layer, ch);
    } else {
      channelDebounce = setTimeout(() => {
        commitChannel(layer, ch);
      }, 150);
    }
  };

  layerSelect?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const layer = layerSelect.value;
    const max = syncChannelBounds(layer);
    const ch = Math.min(Number(channelSlider?.value || 0), max - 1);
    onChannelInput(ch, true);
  });

  channelSlider?.addEventListener("input", () => {
    onChannelInput(channelSlider.value, false);
  });
  channelSlider?.addEventListener("change", () => {
    onChannelInput(channelSlider.value, true);
  });

  channelNumber?.addEventListener("input", () => {
    onChannelInput(channelNumber.value, false);
  });
  channelNumber?.addEventListener("change", () => {
    onChannelInput(channelNumber.value, true);
  });

  channelPrev?.addEventListener("click", () => {
    const cur = Number(channelSlider?.value || 0);
    onChannelInput(cur - 1, true);
  });

  channelNext?.addEventListener("click", () => {
    const cur = Number(channelSlider?.value || 0);
    onChannelInput(cur + 1, true);
  });

  randomBtn?.addEventListener("click", () => {
    if (!isActive() || !canInteract()) return;
    const layer = layerSelect?.value || model.selectedLayer;
    const max = getInceptionLayerChannels(layer);
    const randomCh = Math.floor(Math.random() * max);
    onChannelInput(randomCh, true);
  });

  archetypes?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const idx = Number(archetypes.value);
    if (idx >= 0 && FEATURE_TARGETS[idx]) {
      const target = FEATURE_TARGETS[idx];
      if (layerSelect) layerSelect.value = target.layer;
      syncChannelBounds(target.layer);
      if (channelSlider) channelSlider.value = String(target.channel);
      if (channelNumber) channelNumber.value = String(target.channel);
      model.setNeuronTarget(target.layer, target.channel);
      syncCustomTarget(target.layer, target.channel);
      if (gallery) {
        gallery.update(
          { targetLayer: target.layer, targetChannel: target.channel, dreamStrength: 0.2 },
          {},
        );
      }
      const paramSelect = elements.parameterControls?.querySelector(
        '.control-block[data-parameter="featureTarget"] select',
      );
      if (paramSelect && paramSelect.value !== String(idx)) {
        paramSelect.value = String(idx);
        paramSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  });

  // Initial synchronization with model's initial state
  syncChannelBounds(model.selectedLayer);
  if (layerSelect) layerSelect.value = model.selectedLayer;
  if (channelSlider) channelSlider.value = String(model.selectedChannel);
  if (channelNumber) channelNumber.value = String(model.selectedChannel);
  syncCustomTarget(model.selectedLayer, model.selectedChannel);
  if (gallery) {
    gallery.update(
      {
        targetLayer: model.selectedLayer,
        targetChannel: model.selectedChannel,
        dreamStrength: 0.2,
      },
      {},
    );
  }

  function update() {
    const layer = model.selectedLayer;
    const channel = model.selectedChannel;
    if (layerSelect && layerSelect.value !== layer) {
      layerSelect.value = layer;
    }
    syncChannelBounds(layer);
    if (channelSlider && Number(channelSlider.value) !== channel) {
      channelSlider.value = String(channel);
    }
    if (channelNumber && Number(channelNumber.value) !== channel) {
      channelNumber.value = String(channel);
    }
    syncCustomTarget(layer, channel);
    if (gallery) {
      gallery.update(
        { targetLayer: layer, targetChannel: channel, dreamStrength: 0.2 },
        {},
      );
    }
  }

  return { update };
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
