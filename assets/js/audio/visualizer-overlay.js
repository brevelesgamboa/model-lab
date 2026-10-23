const STORAGE_KEY = "latent-field:audio-visualizer-config";
const SPECTRUM_POINTS = 48;
const BASS_HISTORY_LEN = 128;
const MIN_AUDIBLE_LEVEL = 0.002;

export const VISUALIZER_COLOR_PRESETS = Object.freeze([
  { id: "cyan", hex: "#54ddff", label: "Cyan" },
  { id: "magenta", hex: "#ff00a0", label: "Magenta" },
  { id: "gold", hex: "#ffb800", label: "Gold" },
  { id: "violet", hex: "#9d4edd", label: "Violet" },
  { id: "white", hex: "#ffffff", label: "White" },
]);

export const DEFAULT_VISUALIZER_CONFIG = Object.freeze({
  enabled: false,
  mode: "spectrum", // "spectrum", "bass_history", "waveform"
  style: "single", // "single", "mirrored"
  fill: "stroke", // "stroke", "fill"
  height: 0.85, // 0.2 to 2.0
  position: 0.15, // 0.05 (near bottom) to 0.95 (near top)
  color: "#54ddff",
  opacity: 0.85, // 0.1 to 1.0
  smoothing: 0.65, // 0.1 to 0.95
  sensitivity: 1.2, // 0.5 to 3.0
  bassEmphasis: 0.6, // 0.0 to 2.0
});

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function hexToRgba(hex, alpha = 1) {
  const clean = String(hex || "#54ddff").replace("#", "");
  const num = parseInt(clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean, 16);
  if (Number.isNaN(num)) return `rgba(84, 221, 255, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class AudioVisualizerOverlay {
  constructor(canvasElement = null) {
    this.canvas = canvasElement;
    this.context = canvasElement ? canvasElement.getContext("2d") : null;
    this.config = { ...DEFAULT_VISUALIZER_CONFIG };

    this.spectrumLevels = new Float32Array(SPECTRUM_POINTS);
    this.spectrumTargets = new Float32Array(SPECTRUM_POINTS);
    this.bassHistory = new Float32Array(BASS_HISTORY_LEN);
    this.bassHead = 0;

    this.isIdle = true;
    this.lastTimestamp = -1;
    this.listeners = new Set();

    this.loadConfig();
  }

  get enabled() {
    return this.config.enabled;
  }

  set enabled(value) {
    this.setOption("enabled", Boolean(value));
  }

  loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.config = this.normalizeConfig(parsed);
      }
    } catch {
      this.config = { ...DEFAULT_VISUALIZER_CONFIG };
    }
  }

  saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch {
      // Storage quota or sandboxed context fallback
    }
  }

  normalizeConfig(input = {}) {
    const validModes = new Set(["spectrum", "bass_history", "waveform"]);
    const validStyles = new Set(["single", "mirrored"]);
    const validFills = new Set(["stroke", "fill"]);

    return {
      enabled: Boolean(input.enabled),
      mode: validModes.has(input.mode) ? input.mode : DEFAULT_VISUALIZER_CONFIG.mode,
      style: validStyles.has(input.style) ? input.style : DEFAULT_VISUALIZER_CONFIG.style,
      fill: validFills.has(input.fill) ? input.fill : DEFAULT_VISUALIZER_CONFIG.fill,
      height: clampNumber(input.height, 0.2, 2.0, DEFAULT_VISUALIZER_CONFIG.height),
      position: clampNumber(input.position, 0.05, 0.95, DEFAULT_VISUALIZER_CONFIG.position),
      color: typeof input.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(input.color)
        ? input.color
        : DEFAULT_VISUALIZER_CONFIG.color,
      opacity: clampNumber(input.opacity, 0.1, 1.0, DEFAULT_VISUALIZER_CONFIG.opacity),
      smoothing: clampNumber(input.smoothing, 0.1, 0.95, DEFAULT_VISUALIZER_CONFIG.smoothing),
      sensitivity: clampNumber(input.sensitivity, 0.5, 3.0, DEFAULT_VISUALIZER_CONFIG.sensitivity),
      bassEmphasis: clampNumber(input.bassEmphasis, 0.0, 2.0, DEFAULT_VISUALIZER_CONFIG.bassEmphasis),
    };
  }

  setOption(key, value) {
    const patch = { [key]: value };
    const normalized = this.normalizeConfig({ ...this.config, ...patch });
    this.config = normalized;
    this.saveConfig();
    this.notify();

    if (!this.config.enabled && this.canvas && this.context) {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvas.hidden = true;
      this.isIdle = true;
    } else if (this.config.enabled && this.canvas) {
      this.canvas.hidden = false;
      this.isIdle = false;
    }
  }

  setOptions(options = {}) {
    this.config = this.normalizeConfig({ ...this.config, ...options });
    this.saveConfig();
    this.notify();

    if (!this.config.enabled && this.canvas && this.context) {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvas.hidden = true;
      this.isIdle = true;
    } else if (this.config.enabled && this.canvas) {
      this.canvas.hidden = false;
      this.isIdle = false;
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((listener) => {
      try {
        listener(this.config);
      } catch {
        // Listener safety
      }
    });
  }

  syncDimensions(targetCanvas) {
    if (!this.canvas || !targetCanvas) return;
    if (this.canvas.width !== targetCanvas.width || this.canvas.height !== targetCanvas.height) {
      this.canvas.width = targetCanvas.width;
      this.canvas.height = targetCanvas.height;
      if (this.context) {
        this.context.imageSmoothingEnabled = true;
      }
    }
  }

  update(timestamp, rhythmController, targetCanvas = null) {
    if (!this.config.enabled) {
      if (this.canvas && !this.canvas.hidden) {
        this.context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.hidden = true;
        this.isIdle = true;
      }
      return;
    }

    if (this.canvas && this.canvas.hidden) {
      this.canvas.hidden = false;
    }

    if (targetCanvas) {
      this.syncDimensions(targetCanvas);
    }

    if (!this.canvas || !this.context) return;

    const elapsed = this.lastTimestamp < 0
      ? 1 / 60
      : Math.min(0.1, Math.max(0.001, (timestamp - this.lastTimestamp) / 1000));
    this.lastTimestamp = timestamp;

    const isActive = rhythmController && rhythmController.status === "active";
    const spectrum = isActive ? rhythmController.getFrequencyData() : null;
    const levels = isActive ? rhythmController.getLevels() : null;
    const hasSignal = Boolean(isActive && levels?.hasSignal);

    switch (this.config.mode) {
      case "bass_history":
        this.renderBassHistory(hasSignal ? levels : null);
        break;
      case "waveform":
        this.renderWaveform(isActive ? rhythmController.getTimeDomainData() : null);
        break;
      case "spectrum":
      default:
        this.renderSpectrum(hasSignal ? spectrum : null, rhythmController, elapsed);
        break;
    }
  }

  renderSpectrum(spectrum, rhythmController, elapsed) {
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const points = SPECTRUM_POINTS;
    const levels = this.spectrumLevels;
    const targets = this.spectrumTargets;

    const analyser = rhythmController?.analyser;
    const audioContext = rhythmController?.context;
    const binWidth = analyser && audioContext
      ? audioContext.sampleRate / analyser.fftSize
      : 23.4375; // Default for 48000 / 2048

    if (spectrum && spectrum.length > 0) {
      const minHz = 30;
      const maxHz = 12000;
      const ratio = maxHz / minHz;

      for (let i = 0; i < points; i += 1) {
        const f0 = minHz * ratio ** (i / points);
        const f1 = minHz * ratio ** ((i + 1) / points);
        const first = Math.max(0, Math.ceil(f0 / binWidth));
        const last = Math.min(spectrum.length - 1, Math.max(first, Math.floor(f1 / binWidth)));

        let sum = 0;
        const count = last - first + 1;
        for (let b = first; b <= last; b += 1) {
          sum += spectrum[b];
        }
        const raw = sum / (count * 255);
        // Bass emphasis weighting: boost lower frequencies quadratically
        const lowOctaveWeight = 1.0 + this.config.bassEmphasis * ((points - 1 - i) / (points - 1)) ** 2;
        targets[i] = Math.max(0, Math.min(1.0, raw * this.config.sensitivity * lowOctaveWeight));
      }
    } else {
      targets.fill(0);
    }

    // Ballistics: fast attack, smooth exponential release
    const attackRate = 0.72;
    const releaseTimeConstant = 0.05 + this.config.smoothing * 0.35;
    const releaseRate = 1 - Math.exp(-elapsed / releaseTimeConstant);

    let maxLevel = 0;
    for (let i = 0; i < points; i += 1) {
      const target = targets[i];
      const current = levels[i];
      if (target > current) {
        levels[i] = current + (target - current) * attackRate;
      } else {
        levels[i] = current + (target - current) * releaseRate;
      }
      if (levels[i] < MIN_AUDIBLE_LEVEL) {
        levels[i] = 0;
      }
      if (levels[i] > maxLevel) {
        maxLevel = levels[i];
      }
    }

    if (maxLevel <= 0 && this.isIdle) {
      return;
    }

    ctx.clearRect(0, 0, width, height);

    if (maxLevel <= 0) {
      this.isIdle = true;
      return;
    }
    this.isIdle = false;

    const baseY = height * (1.0 - this.config.position);
    const ampMax = height * 0.42 * this.config.height;

    const curvePoints = [];
    const stepX = width / (points - 1);
    for (let i = 0; i < points; i += 1) {
      const x = i * stepX;
      const y = baseY - levels[i] * ampMax;
      curvePoints.push({ x, y, val: levels[i] });
    }

    this.drawCurve(ctx, curvePoints, baseY, ampMax);
  }

  renderBassHistory(levels) {
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const history = this.bassHistory;
    const len = BASS_HISTORY_LEN;

    const bassVal = levels
      ? Math.max(0, Math.min(1.0, (levels.kick * 0.65 + levels.bass * 0.35) * this.config.sensitivity))
      : 0;

    history[this.bassHead] = bassVal;
    this.bassHead = (this.bassHead + 1) % len;

    let maxLevel = 0;
    for (let i = 0; i < len; i += 1) {
      if (history[i] > maxLevel) maxLevel = history[i];
    }

    if (maxLevel <= 0 && this.isIdle) {
      return;
    }

    ctx.clearRect(0, 0, width, height);

    if (maxLevel <= 0) {
      this.isIdle = true;
      return;
    }
    this.isIdle = false;

    const baseY = height * (1.0 - this.config.position);
    const ampMax = height * 0.35 * this.config.height;

    const curvePoints = [];
    const stepX = width / (len - 1);
    for (let i = 0; i < len; i += 1) {
      const index = (this.bassHead + i) % len;
      const x = i * stepX;
      const y = baseY - history[index] * ampMax;
      curvePoints.push({ x, y, val: history[index] });
    }

    this.drawCurve(ctx, curvePoints, baseY, ampMax);
  }

  renderWaveform(timeDomainData) {
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const points = 128;

    ctx.clearRect(0, 0, width, height);

    if (!timeDomainData || timeDomainData.length === 0) {
      this.isIdle = true;
      return;
    }

    // Trigger search: find upward zero-crossing near start to stabilize oscilloscope display
    let startIdx = 0;
    for (let i = 0; i < Math.min(256, timeDomainData.length - points); i += 1) {
      if (timeDomainData[i] < 128 && timeDomainData[i + 1] >= 128) {
        startIdx = i;
        break;
      }
    }

    const baseY = height * (1.0 - this.config.position);
    const ampMax = height * 0.28 * this.config.height;
    const stride = Math.max(1, Math.floor((timeDomainData.length - startIdx) / points));

    const curvePoints = [];
    const stepX = width / (points - 1);
    let maxDev = 0;

    for (let i = 0; i < points; i += 1) {
      const sample = timeDomainData[startIdx + i * stride] ?? 128;
      const dev = ((sample - 128) / 128) * this.config.sensitivity;
      if (Math.abs(dev) > maxDev) maxDev = Math.abs(dev);
      const x = i * stepX;
      const y = baseY - dev * ampMax;
      curvePoints.push({ x, y, val: Math.abs(dev) });
    }

    if (maxDev < 0.01) {
      this.isIdle = true;
      return;
    }
    this.isIdle = false;

    this.drawCurve(ctx, curvePoints, baseY, ampMax);
  }

  drawCurve(ctx, points, baseY, ampMax) {
    if (points.length < 2) return;

    const isMirrored = this.config.style === "mirrored";
    const isFill = this.config.fill === "fill";
    const color = this.config.color;
    const opacity = this.config.opacity;

    const traceCurve = (reflect = false) => {
      const firstY = reflect ? baseY + (baseY - points[0].y) : points[0].y;
      ctx.moveTo(points[0].x, firstY);

      for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const y0 = reflect ? baseY + (baseY - p0.y) : p0.y;
        const y1 = reflect ? baseY + (baseY - p1.y) : p1.y;
        const y2 = reflect ? baseY + (baseY - p2.y) : p2.y;
        const y3 = reflect ? baseY + (baseY - p3.y) : p3.y;

        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = y1 + (y2 - y0) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = y2 - (y3 - y1) / 6;

        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, y2);
      }
    };

    ctx.save();

    // 1. Optional Fill Pass
    if (isFill) {
      ctx.beginPath();
      traceCurve(false);
      ctx.lineTo(points[points.length - 1].x, baseY);
      ctx.lineTo(points[0].x, baseY);
      ctx.closePath();

      const topGrad = ctx.createLinearGradient(0, baseY - ampMax, 0, baseY);
      topGrad.addColorStop(0, hexToRgba(color, opacity * 0.4));
      topGrad.addColorStop(1, hexToRgba(color, 0.0));
      ctx.fillStyle = topGrad;
      ctx.fill();

      if (isMirrored) {
        ctx.beginPath();
        traceCurve(true);
        ctx.lineTo(points[points.length - 1].x, baseY);
        ctx.lineTo(points[0].x, baseY);
        ctx.closePath();

        const botGrad = ctx.createLinearGradient(0, baseY + ampMax, 0, baseY);
        botGrad.addColorStop(0, hexToRgba(color, opacity * 0.4));
        botGrad.addColorStop(1, hexToRgba(color, 0.0));
        ctx.fillStyle = botGrad;
        ctx.fill();
      }
    }

    // 2. Subtle Dark Outline / Casing Pass (ensures visibility over bright/busy visuals)
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(8, 6, 12, 0.75)";

    ctx.beginPath();
    traceCurve(false);
    if (isMirrored) {
      traceCurve(true);
    }
    ctx.stroke();

    // 3. Foreground Glowing Stroke Pass
    ctx.lineWidth = 2;
    ctx.strokeStyle = hexToRgba(color, opacity);
    ctx.shadowColor = hexToRgba(color, 0.6);
    ctx.shadowBlur = 6;

    ctx.beginPath();
    traceCurve(false);
    if (isMirrored) {
      traceCurve(true);
    }
    ctx.stroke();

    ctx.restore();
  }

  compositeOnto(targetCanvas) {
    if (!this.config.enabled || !this.canvas || this.isIdle) return;
    const targetCtx = targetCanvas.getContext("2d");
    if (!targetCtx) return;

    targetCtx.save();
    targetCtx.drawImage(
      this.canvas,
      0,
      0,
      targetCanvas.width,
      targetCanvas.height,
    );
    targetCtx.restore();
  }
}

export function initVisualizerUi(
  visualizer,
  elements,
  terminal = () => {},
  setStatus = () => {},
) {
  if (!visualizer || !elements?.toggleAudioVisualizer) return;

  function syncUi(config) {
    elements.toggleAudioVisualizer.textContent = `LINE: ${config.enabled ? "ON" : "OFF"}`;
    elements.toggleAudioVisualizer.classList.toggle("is-active", config.enabled);
    elements.toggleAudioVisualizer.setAttribute(
      "aria-pressed",
      String(config.enabled),
    );

    if (elements.visualizerModeSelect)
      elements.visualizerModeSelect.value = config.mode;
    if (elements.visualizerStyleSelect)
      elements.visualizerStyleSelect.value = config.style;
    if (elements.visualizerFillSelect)
      elements.visualizerFillSelect.value = config.fill;
    if (elements.visualizerHeightRange) {
      elements.visualizerHeightRange.value = String(config.height);
      if (elements.visualizerHeightVal)
        elements.visualizerHeightVal.textContent = `${Math.round(config.height * 100)}%`;
    }
    if (elements.visualizerPositionRange) {
      elements.visualizerPositionRange.value = String(config.position);
      if (elements.visualizerPositionVal)
        elements.visualizerPositionVal.textContent = `${Math.round(config.position * 100)}%`;
    }
    if (elements.visualizerSmoothingRange) {
      elements.visualizerSmoothingRange.value = String(config.smoothing);
      if (elements.visualizerSmoothingVal)
        elements.visualizerSmoothingVal.textContent = `${Math.round(config.smoothing * 100)}%`;
    }
    if (elements.visualizerSensitivityRange) {
      elements.visualizerSensitivityRange.value = String(config.sensitivity);
      if (elements.visualizerSensitivityVal)
        elements.visualizerSensitivityVal.textContent = `${Number(config.sensitivity).toFixed(1)}×`;
    }
    if (elements.visualizerBassRange) {
      elements.visualizerBassRange.value = String(config.bassEmphasis);
      if (elements.visualizerBassVal)
        elements.visualizerBassVal.textContent = Number(
          config.bassEmphasis,
        ).toFixed(1);
    }
    if (elements.visualizerOpacityRange) {
      elements.visualizerOpacityRange.value = String(config.opacity);
      if (elements.visualizerOpacityVal)
        elements.visualizerOpacityVal.textContent = `${Math.round(config.opacity * 100)}%`;
    }
    if (elements.visualizerColorPicker)
      elements.visualizerColorPicker.value = config.color;

    if (elements.visualizerColorPills) {
      const pills = elements.visualizerColorPills.querySelectorAll(
        ".color-preset-pill",
      );
      pills.forEach((pill) => {
        pill.classList.toggle(
          "is-active",
          pill.dataset.color.toLowerCase() === config.color.toLowerCase(),
        );
      });
    }
  }

  // Initial sync
  syncUi(visualizer.config);
  visualizer.subscribe(syncUi);

  // Toggle button
  elements.toggleAudioVisualizer.addEventListener("click", () => {
    const nextState = !visualizer.enabled;
    visualizer.enabled = nextState;
    terminal(
      "VISUALIZER",
      nextState
        ? "audio line overlay enabled"
        : "audio line overlay disabled",
    );
    setStatus(nextState ? "AUDIO VISUALIZER ON" : "AUDIO VISUALIZER OFF");
  });

  // Settings popover toggle
  function togglePopover(show) {
    if (!elements.visualizerSettingsPopover) return;
    const shouldShow =
      typeof show === "boolean"
        ? show
        : elements.visualizerSettingsPopover.hidden;
    elements.visualizerSettingsPopover.hidden = !shouldShow;
    elements.openVisualizerSettings?.classList.toggle("is-active", shouldShow);
  }

  elements.openVisualizerSettings?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover();
  });

  elements.closeVisualizerSettings?.addEventListener("click", () => {
    togglePopover(false);
  });

  // Close popover on outside click or Escape
  document.addEventListener("click", (e) => {
    if (
      elements.visualizerSettingsPopover &&
      !elements.visualizerSettingsPopover.hidden
    ) {
      if (
        !elements.visualizerSettingsPopover.contains(e.target) &&
        e.target !== elements.openVisualizerSettings
      ) {
        togglePopover(false);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      elements.visualizerSettingsPopover &&
      !elements.visualizerSettingsPopover.hidden
    ) {
      togglePopover(false);
    }
  });

  // Option controls
  elements.visualizerModeSelect?.addEventListener("change", (e) => {
    visualizer.setOption("mode", e.target.value);
  });

  elements.visualizerStyleSelect?.addEventListener("change", (e) => {
    visualizer.setOption("style", e.target.value);
  });

  elements.visualizerFillSelect?.addEventListener("change", (e) => {
    visualizer.setOption("fill", e.target.value);
  });

  elements.visualizerHeightRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("height", val);
  });

  elements.visualizerPositionRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("position", val);
  });

  elements.visualizerSmoothingRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("smoothing", val);
  });

  elements.visualizerSensitivityRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("sensitivity", val);
  });

  elements.visualizerBassRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("bassEmphasis", val);
  });

  elements.visualizerOpacityRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("opacity", val);
  });

  elements.visualizerColorPicker?.addEventListener("input", (e) => {
    visualizer.setOption("color", e.target.value);
  });

  elements.visualizerColorPills?.addEventListener("click", (e) => {
    const pill = e.target.closest(".color-preset-pill");
    if (pill && pill.dataset.color) {
      visualizer.setOption("color", pill.dataset.color);
    }
  });
}
