import { clamp } from "../core/utils.js";

const MODULATION_HISTORY_SECONDS = 4;
const MAX_MODULATION_HISTORY_SAMPLES = 240;
const modulationHistory = new WeakMap();

function appendModulationHistory(canvas, frame) {
  const sampledAt = performance.now() / 1000;
  const history = modulationHistory.get(canvas) || [];
  const previous = history[history.length - 1];
  const previousKick = Number(previous?.kickLevel) || 0;
  const entry = {
    ...frame,
    sampledAt,
    kickRise: Math.max(0, frame.kickLevel - previousKick),
  };
  if (previous && sampledAt - previous.sampledAt < 0.025) {
    entry.kickRise = Math.max(previous.kickRise, entry.kickRise);
    history[history.length - 1] = entry;
  } else {
    history.push(entry);
  }
  const cutoff = sampledAt - MODULATION_HISTORY_SECONDS;
  while (history.length > 1 && history[0].sampledAt < cutoff) history.shift();
  if (history.length > MAX_MODULATION_HISTORY_SAMPLES) {
    history.splice(0, history.length - MAX_MODULATION_HISTORY_SAMPLES);
  }
  modulationHistory.set(canvas, history);
  return { history, sampledAt };
}

export function drawModulationVisualizer(
  definition,
  canvas,
  frame,
  formatValue,
) {
  if (!canvas || !frame) return;
  const cssWidth = Math.max(220, Math.round(canvas.clientWidth || 280));
  const cssHeight = 76;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  if (
    canvas.width !== Math.round(cssWidth * ratio) ||
    canvas.height !== Math.round(cssHeight * ratio)
  ) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  const { history, sampledAt } = appendModulationHistory(canvas, frame);
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const range = Math.max(1e-9, maximum - minimum);
  const plotLeft = 4;
  const plotRight = cssWidth - 4;
  const plotTop = 16;
  const plotBottom = cssHeight - 14;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);
  const xForSample = (sample) =>
    plotRight -
    clamp((sampledAt - sample.sampledAt) / MODULATION_HISTORY_SECONDS, 0, 1) *
      plotWidth;
  const yForValue = (value) => {
    const numeric = Number(value);
    const normalized = clamp(
      Number.isFinite(numeric) ? (numeric - minimum) / range : 0,
      0,
      1,
    );
    return plotBottom - normalized * plotHeight;
  };

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#08070a";
  context.fillRect(0, 0, cssWidth, cssHeight);

  context.strokeStyle = "#28232d";
  context.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((fraction) => {
    const x = plotLeft + plotWidth * fraction;
    const y = plotTop + plotHeight * fraction;
    context.beginPath();
    context.moveTo(x + 0.5, plotTop);
    context.lineTo(x + 0.5, plotBottom);
    context.moveTo(plotLeft, y + 0.5);
    context.lineTo(plotRight, y + 0.5);
    context.stroke();
  });

  context.save();
  context.beginPath();
  context.rect(plotLeft, plotTop, plotWidth, plotHeight);
  context.clip();

  history.forEach((sample) => {
    if (sample.audioSource === "none" || sample.kickRise < 0.025) return;
    const strength = clamp(sample.kickRise * 4, 0, 1);
    const x = xForSample(sample);
    context.strokeStyle = `rgba(255,198,92,${0.25 + strength * 0.7})`;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, plotBottom);
    context.lineTo(x, plotBottom - plotHeight * (0.25 + strength * 0.75));
    context.stroke();
  });

  const drawTrace = (key, color, width, predicate = () => true) => {
    let drawing = false;
    let points = 0;
    let lastX = plotRight;
    let lastY = plotBottom;
    context.beginPath();
    history.forEach((sample) => {
      if (!predicate(sample)) {
        drawing = false;
        return;
      }
      const x = xForSample(sample);
      const y = yForValue(sample[key]);
      if (!drawing) context.moveTo(x, y);
      else context.lineTo(x, y);
      drawing = true;
      points += 1;
      lastX = x;
      lastY = y;
    });
    if (points === 1) {
      context.moveTo(Math.max(plotLeft, lastX - 1), lastY);
      context.lineTo(lastX, lastY);
    }
    context.strokeStyle = color;
    context.lineWidth = width;
    context.stroke();
  };

  if (history.length === 1) {
    context.setLineDash([3, 3]);
    context.strokeStyle = "rgba(145,137,151,.62)";
    context.beginPath();
    context.moveTo(plotLeft, yForValue(frame.baseValue));
    context.lineTo(plotRight, yForValue(frame.baseValue));
    context.stroke();
    context.setLineDash([]);
  } else {
    drawTrace("baseValue", "rgba(145,137,151,.72)", 1);
  }
  drawTrace("oscillatorValue", "#9277ff", 1.4, (sample) => sample.lfoActive);
  drawTrace("effectiveValue", "#7deaff", 1.8);

  const oscillatorY = yForValue(frame.oscillatorValue);
  const effectiveY = yForValue(frame.effectiveValue);
  if (
    frame.audioSource !== "none" &&
    Math.abs(effectiveY - oscillatorY) > 0.5
  ) {
    context.strokeStyle =
      frame.audioSource === "kick"
        ? "rgba(255,198,92,.9)"
        : "rgba(125,234,255,.62)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(plotRight, oscillatorY);
    context.lineTo(plotRight, effectiveY);
    context.stroke();
  }
  if (frame.lfoActive) {
    context.fillStyle = "#9277ff";
    context.beginPath();
    context.arc(plotRight, oscillatorY, 2, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#7deaff";
  context.beginPath();
  context.arc(plotRight, effectiveY, 2.6, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.font = "8px IBM Plex Mono, monospace";
  context.fillStyle = "#827a88";
  context.fillText(`BASE ${formatValue(definition, frame.baseValue)}`, 6, 10);
  const effectiveText = `NOW ${formatValue(definition, frame.effectiveValue)}`;
  context.fillStyle = "#7deaff";
  context.fillText(
    effectiveText,
    Math.max(6, cssWidth - context.measureText(effectiveText).width - 6),
    10,
  );
  context.fillStyle = frame.lfoActive ? "#9277ff" : "#51495a";
  context.fillText(frame.lfoActive ? "LFO LIVE" : "LFO OFF", 6, cssHeight - 3);
  const audioText =
    frame.audioSource === "none"
      ? "AUDIO OFF"
      : `${frame.audioSource.toUpperCase()} ${Math.round(frame.audioLevel * 100)}%`;
  context.fillStyle = frame.audioSource === "kick" ? "#ffc65c" : "#62deff";
  context.fillText(
    audioText,
    Math.max(6, cssWidth - context.measureText(audioText).width - 6),
    cssHeight - 3,
  );
}
