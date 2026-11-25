const SILENT_LEVELS = Object.freeze({
  bass: 0,
  body: 0,
  air: 0,
  music: 0,
  beatId: 0,
  generation: 0,
  onsetTimestamp: -Infinity,
  beatStrength: 0,
  kick: 0,
  kickOnset: 0,
  activity: 0,
  bassPhase: 0,
  hasSignal: false,
});

const BAND_TIMES = {
  bass: [0.05, 0.35],
  body: [0.08, 0.45],
  air: [0.025, 0.2],
};
const MIN_WAVE_POWER = 1e-8;
const MAX_AUTO_GAIN = 12;

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
    this.timeDomainData = null;
    this.floatTimeDomainData = null;
    this.beatId = 0;
    this.generation = 0;
    this.bandPeaks = { bass: 0.08, body: 0.08, air: 0.08 };
    this.previousKickLog = 0;
    this.onsetTimestamp = -Infinity;
    this.beatStrength = 0;
    this.status = "idle";
    this.error = null;
    this.levels = SILENT_LEVELS;
    this.lastFrameTimestamp = -1;
    this.lastSampleTimestamp = -1;
    this.kickEnvelope = 0;
    this.kickOnsetEnvelope = 0;
    this.kickHoldRemaining = 0;
    this.activityEnvelope = 0;
    this.runningPeak = 0.08;
    this.runningFloor = 0.005;
    this.bassPhase = 0;
    this.inputGain = 1;
    this.kickOffset = 0.06;
    this.kickGate = 0.04;
    this.kickHit = false;
    this.lastKickHitTimestamp = -Infinity;
    this.listeners = new Set();
  }

  setInputGain(value) {
    return this.setAnalysisSetting("inputGain", value, 0.1, 3);
  }

  setKickOffset(value) {
    return this.setAnalysisSetting("kickOffset", value, 0, 0.25);
  }

  setKickGate(value) {
    return this.setAnalysisSetting("kickGate", value, 0, 0.2);
  }

  setAnalysisSetting(key, value, minimum, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return this[key];
    const next = Math.max(minimum, Math.min(maximum, numeric));
    if (next !== this[key]) {
      this[key] = next;
      this.emitState();
    }
    return next;
  }

  getFrequencyData() {
    return this.frequencyData;
  }

  getTimeDomainData() {
    if (!this.analyser) return null;
    if (
      !this.timeDomainData ||
      this.timeDomainData.length !== this.analyser.fftSize
    ) {
      this.timeDomainData = new Uint8Array(this.analyser.fftSize);
    }
    this.analyser.getByteTimeDomainData(this.timeDomainData);
    return this.timeDomainData;
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
    this.floatTimeDomainData = new Float32Array(analyser.fftSize);
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
    this.timeDomainData = null;
    this.floatTimeDomainData = null;

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
    this.generation += 1;
    this.bandPeaks = { bass: 0.08, body: 0.08, air: 0.08 };
    this.previousKickLog = 0;
    this.onsetTimestamp = -Infinity;
    this.beatStrength = 0;
    this.needsOnsetPrime = true;
    this.levels = Object.freeze({
      ...SILENT_LEVELS,
      beatId: this.beatId,
      generation: this.generation,
    });
    this.lastFrameTimestamp = -1;
    this.lastSampleTimestamp = -1;
    this.kickEnvelope = 0;
    this.kickOnsetEnvelope = 0;
    this.kickHoldRemaining = 0;
    this.activityEnvelope = 0;
    this.kickHit = false;
    this.lastKickHitTimestamp = -Infinity;
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
      Math.ceil(maximumHz / binWidth) - 1,
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

  update(frameTimestamp = performance.now()) {
    const timestamp = Number.isFinite(Number(frameTimestamp))
      ? Number(frameTimestamp)
      : performance.now();
    if (timestamp === this.lastFrameTimestamp) return this.levels;
    const gap =
      this.lastSampleTimestamp >= 0 &&
      timestamp - this.lastSampleTimestamp > 500;
    if (gap) this.resetAnalysis();
    this.lastFrameTimestamp = timestamp;
    this.kickHit = false;
    const elapsed =
      this.lastSampleTimestamp < 0
        ? 1 / 60
        : Math.min(
            0.1,
            Math.max(0, (timestamp - this.lastSampleTimestamp) / 1000),
          );
    this.lastSampleTimestamp = timestamp;
    const active =
      this.status === "active" &&
      this.analyser &&
      this.context?.state === "running";
    if (!active) this.needsOnsetPrime = true;
    if (this.context?.state === "suspended") {
      void this.context.resume().catch((error) => {
        this.error = error;
      });
    }
    const raw = { bass: 0, body: 0, air: 0 };
    let wavePower = 0;
    let kickEnergy = 0;
    if (active) {
      if (this.frequencyData)
        this.analyser.getByteFrequencyData(this.frequencyData);
      if (this.floatFrequencyData)
        this.analyser.getFloatFrequencyData(this.floatFrequencyData);
      raw.bass = this.linearBandRMS(28, 160);
      raw.body = this.linearBandRMS(160, 2000);
      raw.air = this.linearBandRMS(2000, 12000);
      kickEnergy = this.linearBandRMS(45, 130);
      if (this.analyser.getFloatTimeDomainData) {
        if (this.floatTimeDomainData?.length !== this.analyser.fftSize)
          this.floatTimeDomainData = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(this.floatTimeDomainData);
        // Remove DC so a microphone offset cannot hold the gate open.
        let mean = 0;
        for (const value of this.floatTimeDomainData) mean += value;
        mean /= this.floatTimeDomainData.length;
        for (const value of this.floatTimeDomainData)
          wavePower += (value - mean) ** 2;
        wavePower /= this.floatTimeDomainData.length;
      } else {
        // Compatibility for older analysers without float waveform support.
        wavePower = raw.bass ** 2 + raw.body ** 2 + raw.air ** 2;
      }
    }
    const hasSignal = Boolean(active && wavePower > MIN_WAVE_POWER);
    const smooth = (previous, target, attack, release) =>
      previous +
      (target - previous) *
        (1 - Math.exp(-elapsed / (target > previous ? attack : release)));
    const bands = {};
    for (const [key, [attack, release]] of Object.entries(BAND_TIMES)) {
      const energy = hasSignal ? raw[key] : 0;
      const peak = this.bandPeaks[key];
      this.bandPeaks[key] = Math.max(0.035, smooth(peak, energy, 0.08, 1.5));
      // The floor can follow silence downward, but never consumes a sustained drone.
      const floor = Math.min(0.0002, energy * 0.1);
      const gain = Math.min(
        MAX_AUTO_GAIN,
        this.inputGain / Math.max(0.025, this.bandPeaks[key] - floor),
      );
      const target = hasSignal
        ? Math.sqrt(clampUnit((energy - floor) * gain))
        : 0;
      bands[key] = clampUnit(
        smooth(this.levels[key] || 0, target, attack, release),
      );
    }
    this.runningPeak = this.bandPeaks.bass;
    this.runningFloor = hasSignal ? Math.min(0.0002, raw.bass * 0.1) : 0;
    // Detect raw positive log flux BEFORE normalization or user gain. A held tone
    // cannot re-trigger as automatic gain recovers, or when the gain slider moves.
    const kickLog = hasSignal ? Math.log1p(kickEnergy * 40) : 0;
    const flux = Math.max(0, kickLog - this.previousKickLog);
    this.previousKickLog = kickLog;
    this.kickOnsetEnvelope *= Math.exp(-elapsed / 0.035);
    this.kickHoldRemaining = Math.max(0, this.kickHoldRemaining - elapsed);
    if (this.kickHoldRemaining === 0)
      this.kickEnvelope *= Math.exp(-elapsed / 0.18);
    const priming = active && this.needsOnsetPrime;
    if (active) this.needsOnsetPrime = false;
    if (
      hasSignal &&
      !gap &&
      !priming &&
      flux > this.kickOffset + this.kickGate &&
      kickEnergy > 0.001 &&
      timestamp - this.lastKickHitTimestamp >= 160
    ) {
      this.beatId += 1;
      this.onsetTimestamp = timestamp;
      this.lastKickHitTimestamp = timestamp;
      this.beatStrength = clampUnit(flux * 1.8);
      this.kickHit = true;
      this.kickOnsetEnvelope = this.beatStrength;
      this.kickEnvelope = Math.max(this.kickEnvelope, this.beatStrength);
      this.kickHoldRemaining = 0.03;
    }
    if (!hasSignal) {
      this.kickHoldRemaining = 0;
      this.beatStrength = 0;
    }
    const music = clampUnit(
      bands.bass * 0.78 + bands.body * 0.18 + bands.air * 0.04,
    );
    this.activityEnvelope = smooth(
      this.activityEnvelope,
      hasSignal ? Math.max(...Object.values(bands)) : 0,
      0.25,
      1.5,
    );
    this.bassPhase = (this.bassPhase + bands.bass * elapsed) % 4096;
    this.levels = Object.freeze({
      ...bands,
      music,
      kick: clampUnit(this.kickEnvelope),
      kickOnset: clampUnit(this.kickOnsetEnvelope),
      activity: clampUnit(this.activityEnvelope),
      bassPhase: this.bassPhase,
      hasSignal,
      beatId: this.beatId,
      generation: this.generation,
      onsetTimestamp: this.onsetTimestamp,
      beatStrength: this.beatStrength,
    });
    return this.levels;
  }
}

export const rhythmController = new RhythmController();
