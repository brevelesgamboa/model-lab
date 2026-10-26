// Presentation helpers never resize a drawing buffer or create an audio analyser.
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
  if (input.classList.contains("control-slider")) {
    input
      .closest(".control-block")
      .style.setProperty("--base-position", `${progress}%`);
  }
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

export function createModulationDraft(label) {
  const draft = document.createElement("section");
  draft.className = "modulation-draft";
  draft.setAttribute("aria-label", `${label} modulation design preview`);
  // TODO: Wire LFO and Web Audio analyzer uniforms.
  // These preview controls deliberately change only their local visual state.
  // Production modulation remains available in the existing routing controls.
  draft.innerHTML = `
    <div class="draft-heading"><strong>Modulation Engine</strong><span class="draft-badge">DRAFT</span></div>
    <div class="draft-wave-controls"><select aria-label="Preview waveform"><option>SINE</option></select><label><input type="checkbox" checked aria-label="Enable modulation preview">ON</label></div>
    <svg class="draft-waveform" viewBox="0 0 250 78" preserveAspectRatio="none" role="img" aria-label="Draft sine waveform with tension handles and playhead">
      <path d="M0 19.5H250M0 39H250M0 58.5H250M31.25 0V78M62.5 0V78M93.75 0V78M125 0V78M156.25 0V78M187.5 0V78M218.75 0V78" fill="none" stroke="#222630" stroke-width=".6"/>
      <path d="M0 39C20 39 26 9 62.5 9S105 69 125 69S168 9 187.5 9S230 39 250 39" fill="none" stroke="#38bdf8" stroke-width="1.6"/>
      <path d="M37 9H88M100 69H150M162 9H213" fill="none" stroke="#38bdf8" stroke-width=".6" opacity=".4"/>
      <g fill="#0d0f14" stroke="#38bdf8" stroke-width="1"><circle cx="62.5" cy="9" r="2.5"/><circle cx="125" cy="69" r="2.5"/><circle cx="187.5" cy="9" r="2.5"/></g>
      <path d="M103 0V78" stroke="#f4f4f6" stroke-width=".7" opacity=".5"/>
    </svg>
    <label class="draft-range">Rate<input type="range" min="0.01" max="4" step="0.01" value="0.5" aria-label="Preview LFO rate"><output>0.50 Hz</output></label>
    <label class="draft-range">Depth<input type="range" min="0" max="100" value="35" aria-label="Preview LFO depth"><output>35%</output></label>
    <div class="draft-audio" data-source="kick">
      <div class="draft-audio-head"><span>AUDIO REACTIVE</span><div class="draft-segments" role="group" aria-label="Preview audio source"><button type="button" data-source="full" aria-pressed="false">FULL</button><button type="button" data-source="kick" aria-pressed="true">KICK</button><button type="button" data-source="off" aria-pressed="false">OFF</button></div></div>
      <label class="draft-range">Depth<input type="range" min="0" max="100" value="40" aria-label="Preview audio depth"><output>40%</output></label>
    </div>
    <div class="draft-formula">v(t) = base + LFO(t) × depth + audio(t)</div>
    <p class="draft-notice">Visual preview · does not affect the simulation</p>`;
  draft.addEventListener("input", (event) => {
    const input = event.target;
    if (!input.matches('input[type="range"]')) return;
    const output = input.parentElement.querySelector("output");
    output.textContent =
      input.max === "4"
        ? `${Number(input.value).toFixed(2)} Hz`
        : `${input.value}%`;
  });
  draft
    .querySelector('input[type="checkbox"]')
    .addEventListener("change", (event) => {
      const enabled = event.target.checked;
      event.target.nextSibling.textContent = enabled ? "ON" : "OFF";
      draft.querySelector("svg").style.opacity = enabled ? "1" : ".3";
    });
  draft.querySelectorAll("button[data-source]").forEach((button) => {
    button.addEventListener("click", () => {
      draft.querySelector(".draft-audio").dataset.source =
        button.dataset.source;
      draft.querySelectorAll("button[data-source]").forEach((entry) => {
        entry.setAttribute("aria-pressed", String(entry === button));
      });
    });
  });
  return draft;
}
