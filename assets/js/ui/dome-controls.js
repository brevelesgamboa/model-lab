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

export function setDomeSliderGuidance(containerOrId, guidance) {
  const container =
    typeof containerOrId === "string"
      ? document.getElementById(containerOrId)
      : containerOrId;
  if (!container) return;
  if (!guidance || !guidance.text) {
    container.hidden = true;
    return;
  }
  const tag = container.querySelector(".control-guidance__tag");
  const text = container.querySelector(".control-guidance__text");
  const compute = String(guidance.compute || "neutral").toLowerCase();
  if (tag) {
    tag.className = `control-guidance__tag control-guidance__tag--${compute}`;
    tag.textContent = String(guidance.tag || compute).toUpperCase();
  }
  if (text) {
    text.textContent = guidance.text;
  }
  container.hidden = false;
}

export function createDomeNcaControls(
  elements,
  model,
  isActive,
  canInteract,
  onParameterChange,
  { openGrowthGallery } = {},
) {
  const {
    domeNcaPresetLabel,
    domeBrowseNca,
    domeNcaResolution,
    domeNcaReseed,
    domeNcaSheen,
    domeNcaSheenVal,
    domeNcaSheenGuidance,
    domePhotoProtection,
    domePhotoProtectionVal,
    domePhotoProtectionGuidance,
  } = elements;

  function update() {
    if (domeNcaPresetLabel) {
      const name = model.ncaPresetName || model.ncaPreset || "Membrane Field";
      domeNcaPresetLabel.textContent = name;
      domeNcaPresetLabel.title = name;
    }
    if (domeNcaResolution && model.ncaSize) {
      domeNcaResolution.value = String(model.ncaSize);
    }
    if (domeNcaSheen) {
      const val = model.ncaSheen ?? 0.65;
      domeNcaSheen.value = String(val);
      if (domeNcaSheenVal)
        domeNcaSheenVal.textContent = Number(val).toFixed(2);
    }
    if (domePhotoProtection) {
      const val = model.photoProtection ?? 0.65;
      domePhotoProtection.value = String(val);
      if (domePhotoProtectionVal)
        domePhotoProtectionVal.textContent = Number(val).toFixed(2);
    }
    setDomeSliderGuidance(domeNcaSheenGuidance, model.ncaSheenGuidance);
    setDomeSliderGuidance(
      domePhotoProtectionGuidance,
      model.photoProtectionGuidance,
    );
  }

  domeBrowseNca?.addEventListener("click", () => {
    if (!isActive() || !canInteract()) return;
    if (openGrowthGallery) {
      openGrowthGallery({
        onSelect: (patternId, pattern) => {
          void model.setNcaPreset(patternId, pattern);
        },
        getActivePatternId: () => model.ncaPresetId,
      });
    }
  });

  domeNcaResolution?.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    const res = Number(domeNcaResolution.value) || 256;
    void model.setNcaResolution(res);
  });

  domeNcaReseed?.addEventListener("click", () => {
    if (!isActive() || !canInteract()) return;
    model.reseedNca();
  });

  const syncSheen = () => {
    if (!isActive()) return;
    const val = Number(domeNcaSheen.value);
    model.ncaSheen = val;
    if (domeNcaSheenVal)
      domeNcaSheenVal.textContent = val.toFixed(2);
    onParameterChange?.("ncaSheen", val);
  };
  domeNcaSheen?.addEventListener("input", syncSheen);
  domeNcaSheen?.addEventListener("change", syncSheen);

  const syncPhotoProtection = () => {
    if (!isActive()) return;
    const val = Number(domePhotoProtection.value);
    model.photoProtection = val;
    if (domePhotoProtectionVal)
      domePhotoProtectionVal.textContent = val.toFixed(2);
    onParameterChange?.("photoProtection", val);
  };
  domePhotoProtection?.addEventListener("input", syncPhotoProtection);
  domePhotoProtection?.addEventListener("change", syncPhotoProtection);

  return { update };
}
