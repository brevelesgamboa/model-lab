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
          onSelect(neuron) {
            if (!isActive() || !canInteract()) return;
            const ch = neuron.channel < 0 ? 0 : neuron.channel;
            if (layerSelect) layerSelect.value = neuron.layer;
            syncChannelBounds(neuron.layer);
            if (channelSlider) channelSlider.value = String(ch);
            if (channelNumber) channelNumber.value = String(ch);
            model.setNeuronTarget(neuron.layer, ch);
          },
          onSensorSelect(neuron) {
            if (!isActive() || !canInteract()) return;
            const ch = neuron.channel < 0 ? 0 : neuron.channel;
            if (layerSelect) layerSelect.value = neuron.layer;
            syncChannelBounds(neuron.layer);
            if (channelSlider) channelSlider.value = String(ch);
            if (channelNumber) channelNumber.value = String(ch);
            model.setNeuronTarget(neuron.layer, ch);
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

  layerSelect?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const layer = layerSelect.value;
    const max = syncChannelBounds(layer);
    const ch = Math.min(Number(channelSlider?.value || 0), max - 1);
    if (channelSlider) channelSlider.value = String(ch);
    if (channelNumber) channelNumber.value = String(ch);
    model.setNeuronTarget(layer, ch);
  });

  const onChannelInput = (value) => {
    if (!isActive() || !canInteract()) return;
    const layer = layerSelect?.value || model.selectedLayer;
    const max = getInceptionLayerChannels(layer);
    const ch = Math.max(0, Math.min(Number(value) || 0, max - 1));
    if (channelSlider) channelSlider.value = String(ch);
    if (channelNumber) channelNumber.value = String(ch);
    model.setNeuronTarget(layer, ch);
  };

  channelSlider?.addEventListener("input", () => {
    onChannelInput(channelSlider.value);
  });

  channelNumber?.addEventListener("input", () => {
    onChannelInput(channelNumber.value);
  });

  randomBtn?.addEventListener("click", () => {
    if (!isActive() || !canInteract()) return;
    const layer = layerSelect?.value || model.selectedLayer;
    const max = getInceptionLayerChannels(layer);
    const randomCh = Math.floor(Math.random() * max);
    if (channelSlider) channelSlider.value = String(randomCh);
    if (channelNumber) channelNumber.value = String(randomCh);
    model.setNeuronTarget(layer, randomCh);
  });

  archetypes?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const idx = Number(archetypes.value);
    const target = FEATURE_TARGETS[idx];
    if (target) {
      if (layerSelect) layerSelect.value = target.layer;
      syncChannelBounds(target.layer);
      if (channelSlider) channelSlider.value = String(target.channel);
      if (channelNumber) channelNumber.value = String(target.channel);
      model.setNeuronTarget(target.layer, target.channel);
    }
  });

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
    if (archetypes && model.selectedTarget >= 0) {
      archetypes.value = String(model.selectedTarget);
    }
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
