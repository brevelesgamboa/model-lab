import { rhythmController } from "../core/rhythm-controller.js";

function getAudioElements() {
  return {
    toggleAudioInput: document.getElementById("toggle-audio-input"),
    audioMeter: document.getElementById("audio-meter"),
  };
}

export function drawAudioMeter() {
  const audioMeter = document.getElementById("audio-meter");
  if (!audioMeter) return;
  const context = audioMeter.getContext("2d", { alpha: false });
  if (!context) return;

  const width = audioMeter.width;
  const height = audioMeter.height;
  const spectrum = rhythmController.getFrequencyData();
  const analyser = rhythmController.analyser;
  const audioContext = rhythmController.context;
  const binWidth =
    analyser && audioContext ? audioContext.sampleRate / analyser.fftSize : 0;
  const active =
    rhythmController.status === "active" && Boolean(spectrum) && binWidth > 0;

  const barCount = 21;
  const gap = 1;
  const barWidth = (width - gap * (barCount + 1)) / barCount;

  context.fillStyle = "#17131b";
  context.fillRect(0, 0, width, height);
  for (let bar = 0; bar < barCount; bar += 1) {
    let level = 0;
    if (active) {
      const minimumHz = 30 * 400 ** (bar / barCount);
      const maximumHz = 30 * 400 ** ((bar + 1) / barCount);
      const first = Math.max(0, Math.ceil(minimumHz / binWidth));
      const last = Math.min(
        spectrum.length - 1,
        Math.max(first, Math.floor(maximumHz / binWidth)),
      );
      let total = 0;
      for (let index = first; index <= last; index += 1) {
        total += spectrum[index];
      }
      level = Math.max(
        0,
        Math.min(1, (total / ((last - first + 1) * 255) - 0.012) / 0.66),
      );
    }
    const barHeight = active
      ? Math.max(1, Math.round(level * (height - 3)))
      : 1;
    context.fillStyle = bar < 7 ? "#7254f4" : bar < 14 ? "#54ddff" : "#f4f0f7";
    context.globalAlpha = active ? 0.38 + level * 0.62 : 0.14;
    context.fillRect(
      gap + bar * (barWidth + gap),
      height - barHeight - 1,
      Math.max(1, barWidth),
      barHeight,
    );
  }
  context.globalAlpha = 1;
}

export function updateAudioUi() {
  const { toggleAudioInput, audioMeter } = getAudioElements();
  if (!toggleAudioInput) return;

  const audioCaptureActive = rhythmController.status === "active";
  const requesting = rhythmController.status === "requesting";
  toggleAudioInput.disabled = requesting;
  toggleAudioInput.classList.toggle("is-active", audioCaptureActive);
  toggleAudioInput.classList.toggle(
    "is-denied",
    rhythmController.status === "denied",
  );
  toggleAudioInput.setAttribute("aria-pressed", String(audioCaptureActive));

  const labels = {
    idle: "AUDIO: OFF",
    requesting: "PICK SOURCE…",
    active: "AUDIO: ON",
    denied: "AUDIO: DENIED",
    unsupported: "AUDIO: N/A",
    error: "AUDIO: ERROR",
  };
  toggleAudioInput.textContent = labels[rhythmController.status] || labels.idle;
  toggleAudioInput.title = audioCaptureActive
    ? "Audio analysis is local to this browser. Click to stop and release the shared source."
    : "Choose system/tab audio or a microphone, then route its bands in a parameter Modulation Panel.";
  if (audioMeter) {
    audioMeter.setAttribute(
      "aria-label",
      `Audio spectrum: ${audioCaptureActive ? "active" : rhythmController.status}`,
    );
  }
  drawAudioMeter();
}

export async function toggleAudioInput(
  setAnimation,
  terminal,
  setStatus,
  renderCurrentFrame,
) {
  if (rhythmController.status === "requesting") return;

  if (rhythmController.status === "active") {
    rhythmController.stop();
    updateAudioUi();
    renderCurrentFrame({ forceAnalysis: true });
    terminal("AUDIO", "audio processing stopped");
    setStatus("AUDIO REACTIVITY OFF");
    return;
  }

  // Start/resume Web Audio synchronously inside the click gesture, before any picker opens.
  let resumePromise;
  try {
    resumePromise = rhythmController.resumeContext();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminal("AUDIO", message, "warning");
    setStatus("AUDIO UNAVAILABLE");
    return;
  }

  const useSystemAudio = window.confirm(
    "Choose your audio source:\n\n" +
      "[ OK ] System / Tab Audio (Chrome / Edge)\n" +
      "[ Cancel ] Microphone / Room Audio",
  );

  try {
    await resumePromise;
    if (useSystemAudio) {
      await rhythmController.startSystemAudio();
      terminal(
        "AUDIO",
        "system audio analyser enabled; shared audio stays on this device",
      );
      setStatus("SYSTEM AUDIO READY");
    } else {
      await rhythmController.startMicrophone();
      terminal(
        "AUDIO",
        "microphone analyser enabled; captured audio stays on this device",
      );
      setStatus("MICROPHONE AUDIO READY");
    }
    setAnimation(true, { log: false });
    renderCurrentFrame({ forceAnalysis: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminal("AUDIO", `access failed: ${message}`, "warning");
    setStatus("AUDIO UNAVAILABLE");
  } finally {
    updateAudioUi();
  }
}
