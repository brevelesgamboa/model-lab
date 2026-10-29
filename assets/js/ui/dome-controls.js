import { FEATURE_TARGETS } from "../models/inception-feature-map.js";

export function createDomeNeuronControls(
  elements,
  model,
  isActive,
  canInteract,
  onParameterChange,
) {
  const { domeArchetypes: archetypes } = elements;

  archetypes?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const idx = Number(archetypes.value);
    if (idx >= 0 && FEATURE_TARGETS[idx]) {
      const target = FEATURE_TARGETS[idx];
      onParameterChange?.("featureTarget", idx);
      model.setNeuronTarget(target.layer, target.channel);
    }
  });

  if (archetypes && model.selectedTarget >= 0) {
    archetypes.value = String(model.selectedTarget);
  }

  function update() {
    const idx = model.selectedTarget;
    if (archetypes && Number(archetypes.value) !== idx && idx >= 0) {
      archetypes.value = String(idx);
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
