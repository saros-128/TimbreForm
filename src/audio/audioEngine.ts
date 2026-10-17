import type { SpectrumInput } from "./dsp";
import {
  DEFAULT_AUDIO_INPUT_PROFILE,
  LIVE_ANALYSIS_PROFILE,
  MICROPHONE_INPUT_PROFILE,
  type AudioInputProfileId,
} from "./profile";

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export type AudioSourceKind = "microphone" | "demo";
export type AudioSourceEndReason = "ended" | "muted";

interface AudioGraph {
  context: AudioContext;
  analyser: AnalyserNode;
  inputGain: GainNode;
  microphoneHighpass: BiquadFilterNode;
  sinkGain: GainNode;
  frequencyData: Float32Array<ArrayBuffer>;
  timeData: Float32Array<ArrayBuffer>;
}

interface AudioResources {
  graph: AudioGraph;
  stream: MediaStream | null;
  oscillators: OscillatorNode[];
  sourceKind: AudioSourceKind;
}

type SourceEndedHandler = (reason: AudioSourceEndReason) => void;

export class AudioEngine {
  private graph: AudioGraph | null = null;
  private stream: MediaStream | null = null;
  private oscillators: OscillatorNode[] = [];
  private detachTrackListeners: (() => void) | null = null;
  private pendingResources = new Map<number, AudioResources>();
  private generation = 0;
  private desiredGain = 1;
  private desiredInputProfile: AudioInputProfileId = DEFAULT_AUDIO_INPUT_PROFILE;

  sourceKind: AudioSourceKind | null = null;

  constructor(private readonly onSourceEnded?: SourceEndedHandler) {}

  static isSupported(): boolean {
    return Boolean(
      typeof window !== "undefined" &&
        window.AudioContext &&
        navigator.mediaDevices?.getUserMedia,
    );
  }

  static async listInputs(): Promise<AudioInputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    let anonymousIndex = 1;
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `Аудиовход ${anonymousIndex++}`,
      }));
  }

  async startMicrophone(deviceId?: string): Promise<boolean> {
    const generation = ++this.generation;
    await this.disposeCurrent();
    if (generation !== this.generation) return false;
    if (!AudioEngine.isSupported()) {
      throw new Error("Web Audio или доступ к устройствам ввода не поддерживается браузером.");
    }

    const constraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48_000 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };

    let stream: MediaStream | null = null;
    let graph: AudioGraph | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      graph = this.createGraph(this.desiredInputProfile);
      this.pendingResources.set(generation, {
        graph,
        stream,
        oscillators: [],
        sourceKind: "microphone",
      });
      graph.context.createMediaStreamSource(stream).connect(graph.inputGain);
      await graph.context.resume();
      if (
        generation !== this.generation ||
        !this.pendingResources.delete(generation)
      ) return false;

      this.commit(graph, "microphone", stream, []);
      this.watchTrack(stream.getAudioTracks()[0], generation);
      return true;
    } catch (error) {
      if (graph && this.pendingResources.delete(generation)) {
        await this.disposeResources(graph, stream, []);
      }
      else stream?.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  async startDemo(midis: readonly number[]): Promise<boolean> {
    const generation = ++this.generation;
    await this.disposeCurrent();
    if (generation !== this.generation) return false;

    const graph = this.createGraph();
    const oscillators: OscillatorNode[] = [];
    this.pendingResources.set(generation, {
      graph,
      stream: null,
      oscillators,
      sourceKind: "demo",
    });
    try {
      const now = graph.context.currentTime;
      const noteGain = 0.14 / Math.max(1, Math.sqrt(midis.length));
      for (const midi of midis) {
        const fundamental = 440 * 2 ** ((midi - 69) / 12);
        for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
          const frequency = fundamental * harmonic;
          if (frequency >= graph.context.sampleRate / 2) break;
          const oscillator = graph.context.createOscillator();
          const partialGain = graph.context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          oscillator.detune.value = harmonic % 2 === 0 ? 0.6 : -0.4;
          partialGain.gain.value = noteGain / harmonic ** 0.82;
          oscillator.connect(partialGain);
          partialGain.connect(graph.inputGain);
          oscillator.start(now);
          oscillators.push(oscillator);
        }
      }

      await graph.context.resume();
      if (
        generation !== this.generation ||
        !this.pendingResources.delete(generation)
      ) return false;
      this.commit(graph, "demo", null, oscillators);
      return true;
    } catch (error) {
      if (this.pendingResources.delete(generation)) {
        await this.disposeResources(graph, null, oscillators);
      }
      throw error;
    }
  }

  async startDemoSequence(midis: readonly number[]): Promise<boolean> {
    const generation = ++this.generation;
    await this.disposeCurrent();
    if (generation !== this.generation) return false;

    const graph = this.createGraph();
    const oscillators: OscillatorNode[] = [];
    this.pendingResources.set(generation, {
      graph,
      stream: null,
      oscillators,
      sourceKind: "demo",
    });
    try {
      const firstOnset = graph.context.currentTime + 0.32;
      const stepSeconds = 0.68;
      midis.forEach((midi, noteIndex) => {
        const fundamental = 440 * 2 ** ((midi - 69) / 12);
        const onset = firstOnset + noteIndex * stepSeconds;
        for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
          const frequency = fundamental * harmonic;
          if (frequency >= graph.context.sampleRate / 2) break;
          const oscillator = graph.context.createOscillator();
          const partialGain = graph.context.createGain();
          const peakGain = 0.16 / harmonic ** 0.82;
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          oscillator.detune.value = harmonic % 2 === 0 ? 0.5 : -0.35;
          partialGain.gain.setValueAtTime(0.0001, graph.context.currentTime);
          partialGain.gain.setValueAtTime(0.0001, onset);
          partialGain.gain.exponentialRampToValueAtTime(peakGain, onset + 0.012);
          partialGain.gain.exponentialRampToValueAtTime(peakGain * 0.28, onset + 0.48);
          partialGain.gain.exponentialRampToValueAtTime(0.0001, onset + 0.62);
          oscillator.connect(partialGain);
          partialGain.connect(graph.inputGain);
          oscillator.start(onset);
          oscillator.stop(onset + 0.64);
          oscillators.push(oscillator);
        }
      });

      await graph.context.resume();
      if (
        generation !== this.generation ||
        !this.pendingResources.delete(generation)
      ) return false;
      this.commit(graph, "demo", null, oscillators);
      return true;
    } catch (error) {
      if (this.pendingResources.delete(generation)) {
        await this.disposeResources(graph, null, oscillators);
      }
      throw error;
    }
  }

  setGain(value: number): void {
    this.desiredGain = value;
    if (!this.graph) return;
    this.graph.inputGain.gain.setTargetAtTime(value, this.graph.context.currentTime, 0.015);
  }

  setInputProfile(profile: AudioInputProfileId): void {
    if (profile === this.desiredInputProfile) return;
    this.desiredInputProfile = profile;
    if (this.graph && this.sourceKind === "microphone") {
      this.connectInputProfile(this.graph, profile, true);
    }
    for (const pending of this.pendingResources.values()) {
      if (pending.sourceKind === "microphone") {
        this.connectInputProfile(pending.graph, profile, true);
      }
    }
  }

  snapshot(timestampMs: number): SpectrumInput | null {
    const graph = this.graph;
    if (!graph) return null;
    graph.analyser.getFloatFrequencyData(graph.frequencyData);
    graph.analyser.getFloatTimeDomainData(graph.timeData);
    return {
      frequencyData: graph.frequencyData,
      timeData: graph.timeData,
      sampleRate: graph.context.sampleRate,
      fftSize: graph.analyser.fftSize,
      timestampMs,
      capture: { clockId: `input-${this.generation}`, endSample: Math.round(graph.context.currentTime * graph.context.sampleRate), sampleRate: graph.context.sampleRate, windowSamples: graph.analyser.fftSize },
    };
  }

  async stop(): Promise<void> {
    this.generation += 1;
    await this.disposeCurrent();
  }

  private createGraph(
    inputProfile: AudioInputProfileId = DEFAULT_AUDIO_INPUT_PROFILE,
  ): AudioGraph {
    const context = new AudioContext({
      latencyHint: "interactive",
      sampleRate: 48_000,
    });
    try {
      const analyser = context.createAnalyser();
      const inputGain = context.createGain();
      const microphoneHighpass = context.createBiquadFilter();
      const sinkGain = context.createGain();

      analyser.fftSize = LIVE_ANALYSIS_PROFILE.fftSize;
      analyser.smoothingTimeConstant = LIVE_ANALYSIS_PROFILE.smoothingTimeConstant;
      analyser.minDecibels = -110;
      analyser.maxDecibels = -8;
      inputGain.gain.value = this.desiredGain;
      microphoneHighpass.type = "highpass";
      microphoneHighpass.frequency.value = MICROPHONE_INPUT_PROFILE.highpassFrequencyHz;
      microphoneHighpass.Q.value = MICROPHONE_INPUT_PROFILE.highpassQ;
      sinkGain.gain.value = 0;
      analyser.connect(sinkGain);
      sinkGain.connect(context.destination);

      const graph = {
        context,
        analyser,
        inputGain,
        microphoneHighpass,
        sinkGain,
        frequencyData: new Float32Array(analyser.frequencyBinCount),
        timeData: new Float32Array(analyser.fftSize),
      };
      this.connectInputProfile(graph, inputProfile, false);
      return graph;
    } catch (error) {
      if (context.state !== "closed") void context.close();
      throw error;
    }
  }

  private connectInputProfile(
    graph: AudioGraph,
    profile: AudioInputProfileId,
    reconnect: boolean,
  ): void {
    if (reconnect) {
      graph.inputGain.disconnect();
      graph.microphoneHighpass.disconnect();
    }
    if (profile === "microphone") {
      graph.inputGain.connect(graph.microphoneHighpass);
      graph.microphoneHighpass.connect(graph.analyser);
    } else {
      graph.inputGain.connect(graph.analyser);
    }
  }

  private commit(
    graph: AudioGraph,
    sourceKind: AudioSourceKind,
    stream: MediaStream | null,
    oscillators: OscillatorNode[],
  ): void {
    this.graph = graph;
    this.stream = stream;
    this.oscillators = oscillators;
    this.sourceKind = sourceKind;
  }

  private watchTrack(track: MediaStreamTrack | undefined, generation: number): void {
    if (!track) return;
    let muteTimer: number | null = null;
    const finish = (reason: AudioSourceEndReason) => {
      if (generation !== this.generation) return;
      const endGeneration = ++this.generation;
      void this.disposeCurrent().finally(() => {
        if (endGeneration === this.generation) this.onSourceEnded?.(reason);
      });
    };
    const onEnded = () => finish("ended");
    const onMute = () => {
      muteTimer = window.setTimeout(() => finish("muted"), 1500);
    };
    const onUnmute = () => {
      if (muteTimer !== null) window.clearTimeout(muteTimer);
      muteTimer = null;
    };
    track.addEventListener("ended", onEnded, { once: true });
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    this.detachTrackListeners = () => {
      track.removeEventListener("ended", onEnded);
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
      if (muteTimer !== null) window.clearTimeout(muteTimer);
    };
  }

  private async disposeCurrent(): Promise<void> {
    const graph = this.graph;
    const stream = this.stream;
    const oscillators = this.oscillators;
    const pending = [...this.pendingResources.values()];
    this.pendingResources.clear();
    this.detachTrackListeners?.();
    this.detachTrackListeners = null;
    this.graph = null;
    this.stream = null;
    this.oscillators = [];
    this.sourceKind = null;
    const disposals = pending.map((resources) =>
      this.disposeResources(resources.graph, resources.stream, resources.oscillators),
    );
    if (graph) disposals.push(this.disposeResources(graph, stream, oscillators));
    else stream?.getTracks().forEach((track) => track.stop());
    await Promise.all(disposals);
  }

  private async disposeResources(
    graph: AudioGraph,
    stream: MediaStream | null,
    oscillators: readonly OscillatorNode[],
  ): Promise<void> {
    for (const oscillator of oscillators) {
      try {
        oscillator.stop();
      } catch {
        // It may already have stopped while its context was closing.
      }
      oscillator.disconnect();
    }
    stream?.getTracks().forEach((track) => track.stop());
    if (graph.context.state !== "closed") {
      try {
        await graph.context.close();
      } catch {
        // A concurrent stop may already have closed the context.
      }
    }
  }
}
