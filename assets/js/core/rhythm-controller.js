const SILENT_LEVELS = Object.freeze({
  bass: 0,
  kick: 0,
  kickOnset: 0,
  activity: 0,
  bassPhase: 0,
  hasSignal: false,
});

const AMBIENT_ATTACK_SECONDS = 0.04;
const AMBIENT_RELEASE_SECONDS = 0.18;
const KICK_BASELINE_ATTACK_SECONDS = 0.5;
const KICK_BASELINE_RELEASE_SECONDS = 0.3;
const KICK_HOLD_SECONDS = 0.045;
const KICK_RELEASE_SECONDS = 0.28;
const KICK_ONSET_RELEASE_SECONDS = 0.035;

const MIN_AUDIBLE_POWER = 0.000008;
const MIN_RUNNING_PEAK = 0.035;
const MAX_RUNNING_PEAK = 0.85;
const MIN_RUNNING_FLOOR = 0.001;
const MAX_RUNNING_FLOOR = 0.02;
const MAX_AUTO_GAIN = 5.0;

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
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
    this.floatFrequencyData = null;
    this.status = "idle";
    this.error = null;
    this.levels = SILENT_LEVELS;
    this.lastFrameTimestamp = -1;
    this.lastSampleTimestamp = -1;
    this.slowBass = 0;
    this.kickEnvelope = 0;
    this.kickOnsetEnvelope = 0;
    this.kickHoldRemaining = 0;
    this.activityEnvelope = 0;
    this.runningPeak = 0.08;
    this.runningFloor = 0.005;
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
    this.floatFrequencyData = new Float32Array(analyser.frequencyBinCount);
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
    this.floatFrequencyData = null;

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
    this.kickOnsetEnvelope = 0;
    this.kickHoldRemaining = 0;
    this.runningPeak = 0.08;
    this.runningFloor = 0.005;
    this.bassPhase = 0;
  }

  linearBandRMS(minimumHz, maximumHz) {
    if (!this.analyser || !this.context) return 0;
    const binWidth = this.context.sampleRate / this.analyser.fftSize;
    if (binWidth <= 0) return 0;
    const first = Math.max(0, Math.ceil(minimumHz / binWidth));
    const last = Math.min(
      this.analyser.frequencyBinCount - 1,
      Math.floor(maximumHz / binWidth),
    );
    if (last < first) return 0;
    let powerSum = 0;
    let count = 0;
    if (this.floatFrequencyData) {
      for (let index = first; index <= last; index += 1) {
        const db = this.floatFrequencyData[index];
        if (Number.isFinite(db) && db > -100) {
          powerSum += 10 ** (db / 10);
        }
        count += 1;
      }
    } else if (this.frequencyData) {
      const minDb = this.analyser.minDecibels;
      const maxDb = this.analyser.maxDecibels;
      const span = maxDb - minDb;
      for (let index = first; index <= last; index += 1) {
        const norm = this.frequencyData[index] / 255;
        const db = minDb + norm * span;
        powerSum += 10 ** (db / 10);
        count += 1;
      }
    }
    return count > 0 ? Math.sqrt(powerSum / count) : 0;
  }

  rmsBand(minimumHz, maximumHz) {
    if (!this.analyser || !this.frequencyData || !this.context) return 0;
    const binWidth = this.context.sampleRate / this.analyser.fftSize;
    if (binWidth <= 0) return 0;
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
      !this.context ||
      (!this.frequencyData && !this.floatFrequencyData)
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

    if (this.frequencyData) {
      this.analyser.getByteFrequencyData(this.frequencyData);
    }
    if (this.floatFrequencyData) {
      this.analyser.getFloatFrequencyData(this.floatFrequencyData);
    }

    // Sub-bass band (28 - 160 Hz): covers fundamental bass notes across keys
    const subEnergy = this.linearBandRMS(28, 160);
    // Lower body band (160 - 600 Hz): instrumental warmth and low-mids
    const bodyEnergy = this.linearBandRMS(160, 600);
    // High air band (600 - 5000 Hz): texture and detail
    const airEnergy = this.linearBandRMS(600, 5000);
    // Kick band (45 - 130 Hz): acoustic and electronic kick punch
    const kickBandEnergy = this.linearBandRMS(45, 130);

    const totalPower =
      subEnergy * subEnergy +
      bodyEnergy * bodyEnergy +
      airEnergy * airEnergy;
    const hasSignal = totalPower > MIN_AUDIBLE_POWER;

    const smoothingAmount = (timeConstant) =>
      1 - Math.exp(-elapsed / timeConstant);

    if (!hasSignal) {
      const bassDecay = Math.exp(-elapsed / AMBIENT_RELEASE_SECONDS);
      const kickDecay = Math.exp(-elapsed / KICK_RELEASE_SECONDS);
      const onsetDecay = Math.exp(-elapsed / KICK_ONSET_RELEASE_SECONDS);

      const previousBass =
        this.levels === SILENT_LEVELS ? 0 : this.levels.bass;
      const bass = previousBass * bassDecay;
      this.kickEnvelope *= kickDecay;
      this.kickOnsetEnvelope *= onsetDecay;
      this.slowBass *= Math.exp(-elapsed / KICK_BASELINE_RELEASE_SECONDS);
      this.activityEnvelope *= Math.exp(-elapsed / 1.8);
      this.bassPhase = (this.bassPhase + bass * elapsed) % 4096;

      this.levels = Object.freeze({
        bass: clampUnit(bass),
        kick: clampUnit(this.kickEnvelope),
        kickOnset: clampUnit(this.kickOnsetEnvelope),
        activity: clampUnit(this.activityEnvelope),
        bassPhase: this.bassPhase,
        hasSignal: false,
      });
      return this.levels;
    }

    // Ambient energy prioritizes sub-bass while retaining gentle body response
    const ambientEnergy =
      subEnergy * 0.78 + bodyEnergy * 0.18 + airEnergy * 0.04;

    // Safeguarded dynamic range tracking:
    // Floor only tracks downward or drifts upward very slowly to protect sustained ambient drones
    if (ambientEnergy < this.runningFloor) {
      this.runningFloor = Math.max(MIN_RUNNING_FLOOR, ambientEnergy);
    } else {
      this.runningFloor = Math.min(
        MAX_RUNNING_FLOOR,
        this.runningFloor +
          (0.005 - this.runningFloor) * smoothingAmount(15.0),
      );
    }

    // Peak tracks upward quickly and leaks downward slowly over 4 seconds
    if (ambientEnergy > this.runningPeak) {
      this.runningPeak = Math.min(
        MAX_RUNNING_PEAK,
        this.runningPeak +
          (ambientEnergy - this.runningPeak) * smoothingAmount(0.12),
      );
    } else {
      this.runningPeak = Math.max(
        MIN_RUNNING_PEAK,
        this.runningPeak * Math.exp(-elapsed / 4.0),
      );
    }

    const dynamicSpan = Math.max(
      0.025,
      this.runningPeak - this.runningFloor,
    );
    const autoGain = Math.min(MAX_AUTO_GAIN, 1.0 / dynamicSpan);
    const normalizedAmbient = clampUnit(
      (ambientEnergy - this.runningFloor) * autoGain,
    );
    // Smooth perceptual curve for ambient swells
    const targetBass = clampUnit(Math.sqrt(normalizedAmbient) * 1.05);

    const previousBass =
      this.levels === SILENT_LEVELS ? 0 : this.levels.bass;
    const bassTime =
      targetBass > previousBass
        ? AMBIENT_ATTACK_SECONDS
        : AMBIENT_RELEASE_SECONDS;
    const bass =
      previousBass + (targetBass - previousBass) * smoothingAmount(bassTime);

    // Kick transient detection using slow baseline tracking
    const normalizedKick = clampUnit(
      (kickBandEnergy - this.runningFloor) * autoGain,
    );
    const baselineTimeConstant =
      normalizedKick > this.slowBass
        ? KICK_BASELINE_ATTACK_SECONDS
        : KICK_BASELINE_RELEASE_SECONDS;
    this.slowBass +=
      (normalizedKick - this.slowBass) *
      smoothingAmount(baselineTimeConstant);

    const kickExcess = Math.max(0, normalizedKick - this.slowBass - 0.06);
    const kickHit = kickExcess > 0.04 && normalizedKick > 0.12;
    const kickStrength = kickHit ? clampUnit(kickExcess * 4.5) : 0;

    // Decoupled kick envelopes:
    // 1. Transient onset pulse for shockwave triggering (fast decay, re-arms < 60ms)
    if (kickStrength > this.kickOnsetEnvelope) {
      this.kickOnsetEnvelope = kickStrength;
    } else {
      this.kickOnsetEnvelope *= Math.exp(
        -elapsed / KICK_ONSET_RELEASE_SECONDS,
      );
    }

    // 2. Sustain modulation envelope for visual parameters (hold + smooth release)
    if (kickStrength > 0.3) {
      this.kickEnvelope = Math.max(this.kickEnvelope, kickStrength);
      this.kickHoldRemaining = KICK_HOLD_SECONDS;
    } else if (this.kickHoldRemaining > 0) {
      this.kickHoldRemaining -= elapsed;
    } else {
      this.kickEnvelope *= Math.exp(-elapsed / KICK_RELEASE_SECONDS);
    }

    const rawEnergy = clampUnit(Math.sqrt(normalizedAmbient));
    if (rawEnergy > this.activityEnvelope) {
      this.activityEnvelope +=
        (rawEnergy - this.activityEnvelope) * smoothingAmount(0.08);
    } else {
      this.activityEnvelope *= Math.exp(-elapsed / 1.8);
    }

    this.bassPhase = (this.bassPhase + bass * elapsed) % 4096;

    this.levels = Object.freeze({
      bass: clampUnit(bass),
      kick: clampUnit(this.kickEnvelope),
      kickOnset: clampUnit(this.kickOnsetEnvelope),
      activity: clampUnit(this.activityEnvelope),
      bassPhase: this.bassPhase,
      hasSignal: true,
    });
    return this.levels;
  }
}

export const rhythmController = new RhythmController();

export default rhythmController;
