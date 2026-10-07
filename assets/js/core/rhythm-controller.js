const SILENT_LEVELS = Object.freeze({
  bass: 0,
  kick: 0,
  bassPhase: 0,
  hasSignal: false,
});

const LEVEL_ATTACK_SECONDS = 0.03;
const LEVEL_RELEASE_SECONDS = 0.14;
const KICK_BASELINE_ATTACK_SECONDS = 0.18;
const KICK_BASELINE_RELEASE_SECONDS = 0.11;
const KICK_RELEASE_SECONDS = 0.2;
const KICK_MIN_ENERGY = 0.04;
const KICK_ONSET_FLOOR = 0.015;
const KICK_ONSET_GAIN = 5.5;

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function visualizerLevel(value) {
  const gated = clampUnit((Number(value) - 0.025) / 0.9);
  return gated ** 1.15;
}

export class RhythmController {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.source = null;
    this.mutedGain = null;
    this.mediaElement = null;
    this.stream = null;
    this.captureStream = null;
    this.frequencyData = null;
    this.status = "idle";
    this.error = null;
    this.levels = SILENT_LEVELS;
    this.lastFrameTimestamp = -1;
    this.lastSampleTimestamp = -1;
    this.slowBass = 0;
    this.kickEnvelope = 0;
    this.bassPhase = 0;
    this.listeners = new Set();
  }

  // Kept as read-only compatibility helpers. Runtime code uses status directly.
  get active() {
    return (
      this.status === "active" &&
      Boolean(this.analyser) &&
      this.context?.state === "running"
    );
  }

  get hasSignal() {
    return this.status === "active" && this.levels.hasSignal;
  }

  get frequencyBinWidth() {
    if (!this.context || !this.analyser) return 0;
    return this.context.sampleRate / this.analyser.fftSize;
  }

  getFrequencyData() {
    return this.frequencyData;
  }

  getLevels() {
    return this.levels;
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitState() {
    this.listeners.forEach((listener) => {
      try {
        listener(this);
      } catch (error) {
        console.warn("Rhythm listener failed.", error);
      }
    });
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emitState();
  }

  ensureContext() {
    if (this.context && this.context.state !== "closed") return this.context;
    const AudioContextClass =
      globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass)
      throw new Error("Web Audio is unavailable in this browser.");
    this.context = new AudioContextClass({ latencyHint: "interactive" });
    return this.context;
  }

  resumeContext() {
    const context = this.ensureContext();
    return context.state === "suspended" ? context.resume() : Promise.resolve();
  }

  ensureMediaElement() {
    if (this.mediaElement) return this.mediaElement;
    const mediaElement =
      globalThis.document?.createElement?.("audio") || new Audio();
    mediaElement.id = "rhythm-stream-pull";
    mediaElement.hidden = true;
    mediaElement.autoplay = true;
    mediaElement.muted = true;
    mediaElement.defaultMuted = true;
    mediaElement.volume = 0;
    mediaElement.playsInline = true;
    mediaElement.setAttribute?.("aria-hidden", "true");
    globalThis.document?.body?.append?.(mediaElement);
    this.mediaElement = mediaElement;
    return mediaElement;
  }

  configureAnalyser(context) {
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0.15;
    this.analyser = analyser;
    this.frequencyData = new Uint8Array(analyser.frequencyBinCount);
    return analyser;
  }

  async connectMediaStream(stream, captureStream = stream) {
    if (!stream?.getAudioTracks?.().length)
      throw new Error("A shared audio track is required.");
    this.disconnectSource();

    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume();

    const analyser = this.configureAnalyser(context);
    const source = context.createMediaStreamSource(stream);
    const mutedGain = context.createGain();
    mutedGain.gain.value = 0;
    source.connect(analyser);
    analyser.connect(mutedGain);
    mutedGain.connect(context.destination);

    this.source = source;
    this.mutedGain = mutedGain;
    this.stream = stream;
    this.captureStream = captureStream;

    const mediaElement = this.ensureMediaElement();
    mediaElement.srcObject = stream;
    try {
      await mediaElement.play();
    } catch (error) {
      this.disconnectSource();
      throw new Error(
        `The browser blocked the hidden audio stream: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const track of captureStream.getTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (this.captureStream === captureStream) this.stop();
        },
        { once: true },
      );
    }

    this.resetAnalysis();
    this.setStatus("active");
    return true;
  }

  async startSystemAudio() {
    this.setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(
          "No audio track shared. Check 'Share tab audio' or 'Share system audio' in the picker.",
        );
      }
      // Keep the required display track enabled so browsers continue pulling the
      // shared stream. The track is never rendered or attached to a video element.
      await this.connectMediaStream(stream);
      return true;
    } catch (error) {
      this.setStatus("denied", error);
      throw error;
    }
  }

  async startMicrophone() {
    this.setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      await this.connectMediaStream(stream);
      return true;
    } catch (error) {
      this.setStatus("denied", error);
      throw error;
    }
  }

  disconnectSource() {
    try {
      this.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.mutedGain?.disconnect();
    } catch {
      /* already disconnected */
    }

    const tracks = new Set([
      ...(this.stream?.getTracks?.() || []),
      ...(this.captureStream?.getTracks?.() || []),
    ]);

    this.source = null;
    this.analyser = null;
    this.mutedGain = null;
    this.stream = null;
    this.captureStream = null;
    this.frequencyData = null;

    if (this.mediaElement) {
      this.mediaElement.pause();
      this.mediaElement.srcObject = null;
    }
    tracks.forEach((track) => track.stop());
    this.resetAnalysis();
  }

  stop() {
    this.disconnectSource();
    if (this.context && this.context.state !== "closed") {
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.setStatus("idle");
  }

  resetAnalysis() {
    this.levels = SILENT_LEVELS;
    this.lastFrameTimestamp = -1;
    this.lastSampleTimestamp = -1;
    this.slowBass = 0;
    this.kickEnvelope = 0;
    this.bassPhase = 0;
  }

  rmsBand(minimumHz, maximumHz) {
    if (!this.analyser || !this.frequencyData || !this.context) return 0;
    const binWidth = this.context.sampleRate / this.analyser.fftSize;
    const first = Math.max(0, Math.ceil(minimumHz / binWidth));
    const last = Math.min(
      this.frequencyData.length - 1,
      Math.floor(maximumHz / binWidth),
    );
    if (last < first) return 0;
    let squares = 0;
    for (let index = first; index <= last; index += 1) {
      const value = this.frequencyData[index] / 255;
      squares += value * value;
    }
    return Math.sqrt(squares / (last - first + 1));
  }

  update(frameTimestamp = performance.now()) {
    const numericTimestamp = Number(frameTimestamp);
    const timestamp = Number.isFinite(numericTimestamp)
      ? numericTimestamp
      : performance.now();
    if (timestamp === this.lastFrameTimestamp) return this.levels;
    this.lastFrameTimestamp = timestamp;

    if (
      this.status !== "active" ||
      !this.analyser ||
      !this.frequencyData ||
      !this.context
    ) {
      this.levels = SILENT_LEVELS;
      return this.levels;
    }
    if (this.context.state === "suspended") {
      void this.context.resume().catch((error) => {
        this.error = error;
      });
      return this.levels;
    }

    const elapsed =
      this.lastSampleTimestamp < 0
        ? 1 / 60
        : Math.min(
            0.1,
            Math.max(0, (timestamp - this.lastSampleTimestamp) / 1000),
          );
    this.lastSampleTimestamp = timestamp;

    this.analyser.getByteFrequencyData(this.frequencyData);
    const lowEnergy = this.rmsBand(30, 300);
    const bodyEnergy = this.rmsBand(300, 2500);
    const detailEnergy = this.rmsBand(2500, 10000);
    const kickEnergy = this.rmsBand(35, 180);
    const musicEnergy =
      lowEnergy * 0.72 + bodyEnergy * 0.2 + detailEnergy * 0.08;
    const rawBass = visualizerLevel(musicEnergy);

    const previous =
      this.levels === SILENT_LEVELS ? SILENT_LEVELS : this.levels;
    const smoothingAmount = (timeConstant) =>
      1 - Math.exp(-elapsed / timeConstant);
    const smoothingTime =
      rawBass > previous.bass ? LEVEL_ATTACK_SECONDS : LEVEL_RELEASE_SECONDS;
    const bass =
      previous.bass +
      (rawBass - previous.bass) * smoothingAmount(smoothingTime);

    // Follow the narrow kick band slowly; only a fast rise above it becomes a kick.
    const baselineTimeConstant =
      kickEnergy > this.slowBass
        ? KICK_BASELINE_ATTACK_SECONDS
        : KICK_BASELINE_RELEASE_SECONDS;
    this.slowBass +=
      (kickEnergy - this.slowBass) * smoothingAmount(baselineTimeConstant);

    const kickOnset = Math.max(
      0,
      kickEnergy - this.slowBass - KICK_ONSET_FLOOR,
    );
    const kickTarget =
      kickEnergy > KICK_MIN_ENERGY ? clampUnit(kickOnset * KICK_ONSET_GAIN) : 0;
    const kickRelease = Math.exp(-elapsed / KICK_RELEASE_SECONDS);
    this.kickEnvelope = Math.max(kickTarget, this.kickEnvelope * kickRelease);
    this.bassPhase = (this.bassPhase + bass * elapsed) % 4096;

    this.levels = Object.freeze({
      bass: clampUnit(bass),
      kick: clampUnit(this.kickEnvelope),
      bassPhase: this.bassPhase,
      hasSignal: musicEnergy > 0.02,
    });
    return this.levels;
  }
}

export const rhythmController = new RhythmController();

export default rhythmController;
