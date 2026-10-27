const STORAGE_KEY = "latent-field:audio-visualizer-config";
const NUM_POINTS = 64;
const BASS_HISTORY_LEN = 64;
const MIN_AUDIBLE_LEVEL = 0.003;

export const VISUALIZER_COLOR_PRESETS = Object.freeze([
  { id: "cyan", hex: "#00f0ff", label: "Cyan" },
  { id: "emerald", hex: "#00ff66", label: "Emerald" },
  { id: "magenta", hex: "#ff00a0", label: "Magenta" },
  { id: "white", hex: "#ffffff", label: "White" },
]);

export const DEFAULT_VISUALIZER_CONFIG = Object.freeze({
  enabled: false,
  mode: "waveform", // "waveform", "spectrum", "bass_history"
  style: "single", // "single", "mirrored"
  height: 0.25, // 0.05 to 0.50 (restricted height)
  position: 0.5, // 0.05 to 0.95 (centered in middle)
  opacity: 0.8, // 0.10 to 1.00
  color: "#00f0ff",
});

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function hexToRgb(hex) {
  const clean = String(hex || "#00f0ff").replace("#", "");
  const num = parseInt(
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean,
    16,
  );
  if (Number.isNaN(num)) return [0.0, 0.94, 1.0];
  return [
    ((num >> 16) & 255) / 255,
    ((num >> 8) & 255) / 255,
    (num & 255) / 255,
  ];
}

const VS_SOURCE = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS_SOURCE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

const int NUM_POINTS = 64;
uniform float u_levels[NUM_POINTS];
uniform vec3 u_color;
uniform float u_opacity;
uniform float u_baseY;
uniform float u_height;
uniform int u_style;

float sampleCurve(float u) {
  float t = clamp(u, 0.0, 1.0) * float(NUM_POINTS - 1);
  int i0 = int(floor(t));
  int i1 = min(i0 + 1, NUM_POINTS - 1);
  float f = fract(t);
  float w = f * f * (3.0 - 2.0 * f);
  return mix(u_levels[i0], u_levels[i1], w);
}

void main() {
  float amp = sampleCurve(v_uv.x);
  float targetY = u_baseY + amp * u_height;
  float dist = abs(v_uv.y - targetY);

  if (u_style == 1) {
    float mirrorY = u_baseY - amp * u_height;
    dist = min(dist, abs(v_uv.y - mirrorY));
  }

  float coreThick = 0.0035;
  float core = smoothstep(coreThick, 0.0, dist);
  float glow = exp(-dist * 45.0) * 0.65;
  float alpha = clamp((core + glow) * u_opacity, 0.0, 1.0);

  // Premultiplied alpha output for clean, luminous additive/translucent blending
  fragColor = vec4(u_color * alpha, alpha);
}
`;

export class AudioVisualizerOverlay {
  constructor(canvasElement = null) {
    this.canvas = canvasElement;
    this.gl = null;
    this.context2d = null;

    this.config = { ...DEFAULT_VISUALIZER_CONFIG };
    this.spectrumLevels = new Float32Array(NUM_POINTS);
    this.spectrumTargets = new Float32Array(NUM_POINTS);
    this.bassHistory = new Float32Array(BASS_HISTORY_LEN);
    this.bassHead = 0;
    this.uniformData = new Float32Array(NUM_POINTS);
    this.waveformBuffer = new Float32Array(NUM_POINTS);

    this.frequencyLut = null;
    this.isIdle = true;
    this.lastTimestamp = -1;
    this.listeners = new Set();

    this.initRenderer();
    this.loadConfig();
  }

  get enabled() {
    return this.config.enabled;
  }

  set enabled(value) {
    this.setOption("enabled", Boolean(value));
  }

  initRenderer() {
    if (!this.canvas) return;

    // Prefer WebGL2 for native GPU shader execution; fallback to WebGL1 or 2D
    const glOptions = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    };

    try {
      this.gl =
        this.canvas.getContext("webgl2", glOptions) ||
        this.canvas.getContext("webgl", glOptions);
    } catch {
      this.gl = null;
    }

    if (this.gl) {
      this.initGlProgram();
    } else {
      try {
        this.context2d = this.canvas.getContext("2d");
      } catch {
        this.context2d = null;
      }
    }
  }

  initGlProgram() {
    const gl = this.gl;
    if (!gl) return;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VS_SOURCE);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, FS_SOURCE);
    gl.compileShader(fs);

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      this.gl = null;
      this.context2d = this.canvas.getContext("2d");
      return;
    }

    this.program = program;
    gl.useProgram(program);

    // Quad geometry: full-screen triangle strip
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Uniform locations
    this.uLevelsLoc = gl.getUniformLocation(program, "u_levels");
    this.uColorLoc = gl.getUniformLocation(program, "u_color");
    this.uOpacityLoc = gl.getUniformLocation(program, "u_opacity");
    this.uBaseYLoc = gl.getUniformLocation(program, "u_baseY");
    this.uHeightLoc = gl.getUniformLocation(program, "u_height");
    this.uStyleLoc = gl.getUniformLocation(program, "u_style");
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

    return {
      enabled: Boolean(input.enabled),
      mode: validModes.has(input.mode)
        ? input.mode
        : DEFAULT_VISUALIZER_CONFIG.mode,
      style: validStyles.has(input.style)
        ? input.style
        : DEFAULT_VISUALIZER_CONFIG.style,
      height: clampNumber(
        input.height,
        0.05,
        0.5,
        DEFAULT_VISUALIZER_CONFIG.height,
      ),
      position: clampNumber(
        input.position,
        0.05,
        0.95,
        DEFAULT_VISUALIZER_CONFIG.position,
      ),
      opacity: clampNumber(
        input.opacity,
        0.1,
        1.0,
        DEFAULT_VISUALIZER_CONFIG.opacity,
      ),
      color:
        typeof input.color === "string" &&
        /^#[0-9a-fA-F]{3,8}$/.test(input.color)
          ? input.color
          : DEFAULT_VISUALIZER_CONFIG.color,
    };
  }

  setOption(key, value) {
    const patch = { [key]: value };
    const normalized = this.normalizeConfig({ ...this.config, ...patch });
    this.config = normalized;
    this.saveConfig();
    this.notify();

    if (!this.config.enabled && this.canvas) {
      this.clear();
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

    if (!this.config.enabled && this.canvas) {
      this.clear();
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
    const targetAspect = (targetCanvas.height || 1) / (targetCanvas.width || 1);
    const fixedWidth = 640;
    const fixedHeight = Math.max(
      180,
      Math.min(640, Math.round(fixedWidth * targetAspect)),
    );

    if (
      this.canvas.width !== fixedWidth ||
      this.canvas.height !== fixedHeight
    ) {
      this.canvas.width = fixedWidth;
      this.canvas.height = fixedHeight;
      if (this.gl) {
        this.gl.viewport(0, 0, fixedWidth, fixedHeight);
      }
    }
  }

  clear() {
    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    } else if (this.context2d) {
      this.context2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  buildFrequencyLut(sampleRate = 48000, fftSize = 2048) {
    const binWidth = sampleRate / fftSize;
    const minHz = 30;
    const maxHz = 12000;
    const ratio = maxHz / minHz;
    const lut = [];

    for (let i = 0; i < NUM_POINTS; i += 1) {
      const f0 = minHz * ratio ** (i / NUM_POINTS);
      const f1 = minHz * ratio ** ((i + 1) / NUM_POINTS);
      const first = Math.max(0, Math.ceil(f0 / binWidth));
      const last = Math.min(1023, Math.max(first, Math.floor(f1 / binWidth)));
      const count = Math.max(1, last - first + 1);
      // Quadratic bass emphasis weighting
      const weight = 1.0 + 0.6 * ((NUM_POINTS - 1 - i) / (NUM_POINTS - 1)) ** 2;
      lut.push({ first, last, count, weight });
    }
    this.frequencyLut = lut;
  }

  update(timestamp, rhythmController, targetCanvas = null) {
    if (!this.config.enabled) {
      if (this.canvas && !this.canvas.hidden) {
        this.clear();
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

    if (!this.canvas) return;

    const isActive = rhythmController && rhythmController.status === "active";
    const spectrum = isActive ? rhythmController.getFrequencyData() : null;
    const levels = isActive ? rhythmController.getLevels() : null;
    const hasSignal = Boolean(isActive && levels?.hasSignal);

    switch (this.config.mode) {
      case "bass_history":
        this.renderBassHistory(hasSignal ? levels : null);
        break;
      case "waveform":
        this.renderWaveform(
          isActive ? rhythmController.getTimeDomainData() : null,
        );
        break;
      case "spectrum":
      default:
        this.renderSpectrum(hasSignal ? spectrum : null, rhythmController);
        break;
    }
  }

  renderSpectrum(spectrum, rhythmController) {
    const points = NUM_POINTS;
    const levels = this.spectrumLevels;
    const targets = this.spectrumTargets;

    if (!this.frequencyLut && rhythmController) {
      const sampleRate = rhythmController.context?.sampleRate || 48000;
      const fftSize = rhythmController.analyser?.fftSize || 2048;
      this.buildFrequencyLut(sampleRate, fftSize);
    }

    if (spectrum && spectrum.length > 0 && this.frequencyLut) {
      const lut = this.frequencyLut;
      for (let i = 0; i < points; i += 1) {
        const entry = lut[i];
        let sum = 0;
        for (let b = entry.first; b <= entry.last; b += 1) {
          sum += spectrum[b];
        }
        const raw = (sum / (entry.count * 255)) * entry.weight * 1.35;
        targets[i] = Math.max(0, Math.min(1.0, raw));
      }
    } else {
      targets.fill(0);
    }

    // Ballistics: fast rise, smooth natural fall
    const attackRate = 0.75;
    const releaseRate = 0.14;

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

    if (maxLevel <= 0) {
      this.clear();
      this.isIdle = true;
      return;
    }
    this.isIdle = false;

    this.drawData(levels);
  }

  renderBassHistory(levels) {
    const history = this.bassHistory;
    const len = BASS_HISTORY_LEN;

    const bassVal = levels
      ? Math.max(
          0,
          Math.min(1.0, (levels.kick * 0.7 + levels.bass * 0.3) * 1.35),
        )
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

    if (maxLevel <= 0) {
      this.clear();
      this.isIdle = true;
      return;
    }
    this.isIdle = false;

    // Resample 64 history values down to 32 uniform data points
    const step = len / NUM_POINTS;
    for (let i = 0; i < NUM_POINTS; i += 1) {
      const srcIdx = (this.bassHead + Math.floor(i * step)) % len;
      this.uniformData[i] = history[srcIdx];
    }

    this.drawData(this.uniformData);
  }

  renderWaveform(timeDomainData) {
    if (!timeDomainData || timeDomainData.length === 0) {
      if (!this.isIdle) {
        this.clear();
        this.isIdle = true;
      }
      return;
    }

    // Trigger alignment: find upward zero crossing with hysteresis near start
    let startIdx = 0;
    const maxSearch = Math.min(256, timeDomainData.length - NUM_POINTS * 2);
    for (let i = 0; i < maxSearch; i += 1) {
      if (
        timeDomainData[i] < 128 &&
        timeDomainData[i + 1] >= 128 &&
        timeDomainData[i + 1] - timeDomainData[i] >= 2
      ) {
        startIdx = i;
        break;
      }
    }
    // Fallback to simple zero-crossing
    if (startIdx === 0) {
      for (let i = 0; i < maxSearch; i += 1) {
        if (timeDomainData[i] < 128 && timeDomainData[i + 1] >= 128) {
          startIdx = i;
          break;
        }
      }
    }

    const remaining = timeDomainData.length - startIdx;
    const stride = Math.max(1, Math.floor(remaining / NUM_POINTS));
    let maxDev = 0;

    for (let i = 0; i < NUM_POINTS; i += 1) {
      // Anti-aliased windowed box filter over the stride window
      const winStart = startIdx + i * stride;
      const winEnd = Math.min(timeDomainData.length, winStart + stride);
      let sum = 0;
      let count = 0;
      for (let k = winStart; k < winEnd; k += 1) {
        sum += timeDomainData[k];
        count += 1;
      }
      const avgSample =
        count > 0 ? sum / count : (timeDomainData[winStart] ?? 128);
      const rawDev = ((avgSample - 128) / 128) * 1.35;

      // Temporal inertia filter: smooth 45% new, 55% previous
      this.waveformBuffer[i] += (rawDev - this.waveformBuffer[i]) * 0.45;
      const smoothed = this.waveformBuffer[i];
      if (Math.abs(smoothed) > maxDev) maxDev = Math.abs(smoothed);
      this.uniformData[i] = smoothed;
    }

    if (maxDev < 0.008) {
      for (let i = 0; i < NUM_POINTS; i += 1) {
        this.waveformBuffer[i] *= 0.85;
      }
      if (maxDev < 0.002) {
        if (!this.isIdle) {
          this.clear();
          this.isIdle = true;
        }
        return;
      }
    }
    this.isIdle = false;

    this.drawData(this.uniformData);
  }

  drawData(data) {
    const baseY = this.config.position; // 0.05 to 0.95 (default 0.50)
    const ampHeight = 0.5 * this.config.height;
    const [r, g, b] = hexToRgb(this.config.color);
    const isMirrored = this.config.style === "mirrored";

    if (this.gl && this.program) {
      const gl = this.gl;
      gl.useProgram(this.program);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform1fv(this.uLevelsLoc, data);
      gl.uniform3f(this.uColorLoc, r, g, b);
      gl.uniform1f(this.uOpacityLoc, this.config.opacity);
      gl.uniform1f(this.uBaseYLoc, baseY);
      gl.uniform1f(this.uHeightLoc, ampHeight);
      gl.uniform1i(this.uStyleLoc, isMirrored ? 1 : 0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (this.context2d) {
      // Clean 2D fallback with opacity and glow, without dark casing
      const ctx = this.context2d;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const y0 = h * (1.0 - baseY);
      const ampPx = h * ampHeight;

      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.globalAlpha = this.config.opacity;

      const stepX = w / (NUM_POINTS - 1);
      const drawPath = (reflect = false) => {
        ctx.beginPath();
        for (let i = 0; i < NUM_POINTS; i += 1) {
          const x = i * stepX;
          const val = data[i];
          const y = reflect ? y0 + val * ampPx : y0 - val * ampPx;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      };

      // Soft aura stroke
      ctx.lineWidth = 4.0;
      ctx.strokeStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.35)`;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawPath(false);
      ctx.stroke();
      if (isMirrored) {
        drawPath(true);
        ctx.stroke();
      }

      // Foreground luminous stroke
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = this.config.color;
      drawPath(false);
      ctx.stroke();
      if (isMirrored) {
        drawPath(true);
        ctx.stroke();
      }

      ctx.restore();
    }
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
  onAcousticInjectionChange = () => {},
) {
  if (!visualizer || !elements?.toggleAudioVisualizer) return;

  function syncUi(config) {
    elements.toggleAudioVisualizer.textContent = `Wave: ${config.enabled ? "On" : "Off"}`;
    elements.toggleAudioVisualizer.classList.toggle(
      "is-active",
      config.enabled,
    );
    elements.toggleAudioVisualizer.setAttribute(
      "aria-pressed",
      String(config.enabled),
    );

    if (elements.visualizerModeSelect)
      elements.visualizerModeSelect.value = config.mode;
    if (elements.visualizerStyleSelect)
      elements.visualizerStyleSelect.value = config.style;
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
    if (elements.visualizerOpacityRange) {
      elements.visualizerOpacityRange.value = String(config.opacity ?? 0.8);
      if (elements.visualizerOpacityVal)
        elements.visualizerOpacityVal.textContent = `${Math.round((config.opacity ?? 0.8) * 100)}%`;
    }
    if (elements.visualizerColorPicker) {
      elements.visualizerColorPicker.value = config.color;
    }

    if (elements.visualizerColorPills) {
      const pills =
        elements.visualizerColorPills.querySelectorAll(".color-preset-pill");
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
      nextState ? "audio wave overlay enabled" : "audio wave overlay disabled",
    );
    setStatus(nextState ? "AUDIO WAVE ON" : "AUDIO WAVE OFF");
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

  elements.visualizerInjectionSelect?.addEventListener("change", (e) => {
    onAcousticInjectionChange(e.target.value);
  });

  elements.visualizerHeightRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("height", val);
  });

  elements.visualizerPositionRange?.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    visualizer.setOption("position", val);
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
