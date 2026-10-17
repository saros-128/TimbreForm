import type { HarmonicObservation } from "../domain/harmonicSession";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioEngine,
  type AudioInputDevice,
  type AudioSourceKind,
} from "../audio/audioEngine";
import {
  analyzeSpectrum,
  DEFAULT_ANALYZER_CONFIG,
  estimateMonophonicPitch,
  positiveDifferenceSpectrum,
  positiveSpectralFlux,
  type AnalysisFrame,
  type AnalyzerConfig,
  type MonophonicPitch,
  type SpectrumInput,
} from "../audio/dsp";
import { NoteTracker, type TrackedNote } from "../audio/tracker";
import {
  DEFAULT_STREAMING_ONSET_CONFIG,
  selectOnsetNote,
  shouldStartOnset,
} from "../audio/onset";
import {
  AdaptiveRoomNoiseGate,
  applyAudioInputProfile,
  audioInputProfileAllowsOnset,
  DEFAULT_AUDIO_INPUT_PROFILE,
  LIVE_ANALYSIS_PROFILE,
  resolveAudioInputProfile,
  type AudioInputProfileId,
} from "../audio/profile";

export type AudioStatus = "idle" | "requesting" | "running" | "error";

export interface OnsetPitchEvent {
  sequence: number;
  note: TrackedNote;
  timestampMs: number;
}

export interface WaveformFrame {
  samples: Float32Array<ArrayBuffer>;
  sampleRate: number;
  timestampMs: number;
}

export interface HarmonicAudioState {
  status: AudioStatus;
  sourceKind: AudioSourceKind | null;
  error: string | null;
  devices: AudioInputDevice[];
  frame: AnalysisFrame | null;
  waveform: WaveformFrame | null;
  trackedNotes: TrackedNote[];
  monophonicPitch: MonophonicPitch | null;
  onsetPitch: OnsetPitchEvent | null;
  supported: boolean;
  observation?: HarmonicObservation;
}

const MAX_WAVEFORM_SAMPLES = 2_048;

function copyWaveform(snapshot: SpectrumInput): WaveformFrame {
  const stride = Math.max(
    1,
    Math.ceil(snapshot.timeData.length / MAX_WAVEFORM_SAMPLES),
  );
  const outputLength = Math.max(
    1,
    Math.floor(snapshot.timeData.length / stride),
  );
  const samples = new Float32Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = outputIndex * stride;
    const end = Math.min(snapshot.timeData.length, start + stride);
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += snapshot.timeData[inputIndex];
    }
    samples[outputIndex] = sum / Math.max(1, end - start);
  }

  return {
    samples,
    sampleRate: snapshot.sampleRate / stride,
    timestampMs: snapshot.timestampMs,
  };
}

function describeAudioError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Доступ к аудиовходу запрещён. Разрешите микрофон для этого сайта.";
    }
    if (error.name === "NotFoundError") return "Аудиовход не найден.";
    if (error.name === "NotReadableError") {
      return "Аудиовход занят или недоступен. Проверьте аудиокарту и Ableton.";
    }
  }
  return error instanceof Error ? error.message : "Не удалось открыть аудиовход.";
}

export function useHarmonicAudio(
  config: AnalyzerConfig,
  inputProfile: AudioInputProfileId = DEFAULT_AUDIO_INPUT_PROFILE,
) {
  const engineRef = useRef<AudioEngine | null>(null);
  const trackerRef = useRef(new NoteTracker());
  const animationRef = useRef<number | null>(null);
  const operationRef = useRef(0);
  const gainRef = useRef(1);
  const inputProfileRef = useRef(inputProfile);
  const inputProfileKeyRef = useRef(inputProfile);
  const microphoneGateRef = useRef(new AdaptiveRoomNoiseGate());
  const mountedRef = useRef(true);
  const lastAnalysisAtRef = useRef(0);
  const frameCounterRef = useRef(0);
  const activeBeforeFrameRef = useRef<number[]>([]);
  const previousSpectrumRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const previousRmsRef = useRef(0);
  const pendingOnsetRef = useRef<{
    baseline: Float32Array<ArrayBuffer>;
    framesRemaining: number;
    hadHeldNotes: boolean;
  } | null>(null);
  const fluxFloorRef = useRef(DEFAULT_STREAMING_ONSET_CONFIG.initialFluxFloor);
  const lastOnsetAtRef = useRef(-Infinity);
  const lastTimingOnsetRef = useRef(-Infinity);
  const onsetSequenceRef = useRef(0);
  const configRef = useRef(config);
  const configKey = [
    config.maxPolyphony,
    config.minConfidence,
    config.minSignalToNoiseDb,
    config.minRms,
    config.harmonicSuppression,
    config.nnlsWeight,
  ].join(":");
  const configKeyRef = useRef(configKey);
  const [state, setState] = useState<HarmonicAudioState>({
    status: "idle",
    sourceKind: null,
    error: null,
    devices: [],
    frame: null,
    waveform: null,
    trackedNotes: [],
    monophonicPitch: null,
    onsetPitch: null,
    supported: AudioEngine.isSupported(),
  });

  configRef.current = config;
  inputProfileRef.current = inputProfile;

  const resetTemporalDetection = useCallback(() => {
    previousSpectrumRef.current = null;
    previousRmsRef.current = 0;
    pendingOnsetRef.current = null;
    fluxFloorRef.current = DEFAULT_STREAMING_ONSET_CONFIG.initialFluxFloor;
    lastOnsetAtRef.current = -Infinity;
    lastTimingOnsetRef.current = -Infinity;
    frameCounterRef.current = 0;
    activeBeforeFrameRef.current = [];
  }, []);

  const resetInputDetection = useCallback(() => {
    resetTemporalDetection();
    microphoneGateRef.current.reset();
  }, [resetTemporalDetection]);

  const stopLoop = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);

  const startLoop = useCallback(() => {
    stopLoop();
    const tick = (timestamp: number) => {
      animationRef.current = requestAnimationFrame(tick);
      if (
        timestamp - lastAnalysisAtRef.current <
        LIVE_ANALYSIS_PROFILE.analysisIntervalMs
      ) return;
      lastAnalysisAtRef.current = timestamp;

      const snapshot = engineRef.current?.snapshot(timestamp);
      if (!snapshot) return;
      const waveform = copyWaveform(snapshot);
      const analyzedFrame = analyzeSpectrum(snapshot, configRef.current);
      const activeInputProfile = resolveAudioInputProfile(
        inputProfileRef.current,
        engineRef.current?.sourceKind ?? null,
      );
      const frame = applyAudioInputProfile(
        activeInputProfile,
        analyzedFrame,
        microphoneGateRef.current,
      );
      const activeBeforeFrame = activeBeforeFrameRef.current;
      const trackedNotes = trackerRef.current.update(
        frame.notes,
        timestamp,
        configRef.current.maxPolyphony,
      );
      const previousSpectrum = previousSpectrumRef.current;
      const flux = previousSpectrum
        ? positiveSpectralFlux(
            snapshot.frequencyData,
            previousSpectrum,
            snapshot.sampleRate,
            snapshot.fftSize,
          )
        : 0;
      const timingAttack =
        !frame.gated &&
        shouldStartOnset({
          flux,
          threshold: Math.max(
            DEFAULT_STREAMING_ONSET_CONFIG.absoluteFluxThreshold,
            fluxFloorRef.current *
              DEFAULT_STREAMING_ONSET_CONFIG.fluxFloorMultiplier,
          ),
          rms: frame.rms,
          previousRms: previousRmsRef.current,
          elapsedSinceLastOnsetMs: timestamp - lastTimingOnsetRef.current,
        });
      if (timingAttack) lastTimingOnsetRef.current = timestamp;
      let onsetPitch: OnsetPitchEvent | undefined;

      if (pendingOnsetRef.current) {
        const pendingOnset = pendingOnsetRef.current;
        pendingOnset.framesRemaining -= 1;
        if (pendingOnset.framesRemaining <= 0) {
          const difference = positiveDifferenceSpectrum(
            snapshot.frequencyData,
            pendingOnset.baseline,
          );
          const onsetFrame = analyzeSpectrum(
            { ...snapshot, frequencyData: difference },
            {
              ...configRef.current,
              maxPolyphony: 1,
              minConfidence: Math.min(
                DEFAULT_STREAMING_ONSET_CONFIG.onsetMinConfidence,
                configRef.current.minConfidence,
              ),
              minRms: 0.001,
            },
          );
          const spectralNote = onsetFrame.notes[0];
          const monophonic = estimateMonophonicPitch(
            snapshot.timeData,
            snapshot.sampleRate,
            configRef.current.a4,
          );
          const note = selectOnsetNote(
            spectralNote,
            monophonic,
            pendingOnset.hadHeldNotes,
          );
          if (
            audioInputProfileAllowsOnset(activeInputProfile, frame.gated) &&
            note &&
            note.confidence >= DEFAULT_STREAMING_ONSET_CONFIG.acceptedNoteConfidence
          ) {
            onsetSequenceRef.current += 1;
            onsetPitch = {
              sequence: onsetSequenceRef.current,
              note: {
                ...note,
                state: "active",
                firstSeenMs: timestamp,
                lastSeenMs: timestamp,
                ageMs: 0,
              },
              timestampMs: timestamp,
            };
          }
          pendingOnsetRef.current = null;
        }
      }

      if (previousSpectrum && !pendingOnsetRef.current && !frame.gated) {
        const threshold = Math.max(
          DEFAULT_STREAMING_ONSET_CONFIG.absoluteFluxThreshold,
          fluxFloorRef.current * DEFAULT_STREAMING_ONSET_CONFIG.fluxFloorMultiplier,
        );
        if (
          shouldStartOnset({
            flux,
            threshold,
            rms: frame.rms,
            previousRms: previousRmsRef.current,
            elapsedSinceLastOnsetMs: timestamp - lastOnsetAtRef.current,
          })
        ) {
          pendingOnsetRef.current = {
            baseline: previousSpectrum.slice(),
            framesRemaining: DEFAULT_STREAMING_ONSET_CONFIG.waitFrames,
            hadHeldNotes: activeBeforeFrame.length > 0,
          };
          lastOnsetAtRef.current = timestamp;
        }
      }
      fluxFloorRef.current =
        fluxFloorRef.current * DEFAULT_STREAMING_ONSET_CONFIG.fluxFloorDecay +
        Math.min(
          flux,
          DEFAULT_STREAMING_ONSET_CONFIG.maximumFluxFloorContribution,
        ) *
          (1 - DEFAULT_STREAMING_ONSET_CONFIG.fluxFloorDecay);
      previousSpectrumRef.current = snapshot.frequencyData.slice();
      previousRmsRef.current = frame.rms;
      activeBeforeFrameRef.current = trackedNotes.map(
        (note) => note.pitchClass,
      );
      frameCounterRef.current += 1;
      const monophonicPitch =
        frameCounterRef.current % 3 === 0
          ? estimateMonophonicPitch(
              snapshot.timeData,
              snapshot.sampleRate,
              configRef.current.a4,
            )
          : undefined;

      setState((previous) => ({
        ...previous,
        frame,
        waveform,
        observation: snapshot.capture
          ? {
              capture: snapshot.capture,
              deliveredAtMs: timestamp,
              origin:
                engineRef.current?.sourceKind === "demo" ? "demo" : "captured",
              notes: trackedNotes,
              rms: frame.rms,
              quiet: frame.rms < configRef.current.minRms,
              attack: timingAttack,
              attackedMidi: onsetPitch?.note.midi,
            }
          : undefined,
        trackedNotes,
        ...(monophonicPitch !== undefined ? { monophonicPitch } : {}),
        ...(onsetPitch !== undefined ? { onsetPitch } : {}),
      }));
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [stopLoop]);

  const ensureEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new AudioEngine((reason) => {
        if (!mountedRef.current) return;
        operationRef.current += 1;
        stopLoop();
        trackerRef.current.reset();
        resetInputDetection();
        setState((previous) => ({
          ...previous,
          status: "error",
          sourceKind: null,
          observation: undefined,
          frame: null,
          waveform: null,
          trackedNotes: [],
          monophonicPitch: null,
          onsetPitch: null,
          error:
            reason === "muted"
              ? "Аудиовход перестал передавать данные. Проверьте подключение аудиокарты."
              : "Аудиовход отключён. Выберите устройство и откройте его снова.",
        }));
      });
    }
    engineRef.current.setGain(gainRef.current);
    engineRef.current.setInputProfile(inputProfileRef.current);
    return engineRef.current;
  }, [resetInputDetection, stopLoop]);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await AudioEngine.listInputs();
      setState((previous) => ({ ...previous, devices }));
      return devices;
    } catch {
      return [];
    }
  }, []);

  const startMicrophone = useCallback(
    async (deviceId?: string) => {
      const operation = ++operationRef.current;
      stopLoop();
      trackerRef.current.reset();
      resetInputDetection();
      setState((previous) => ({
        ...previous,
        status: "requesting",
        sourceKind: null,
        observation: undefined,
        frame: null,
        waveform: null,
        trackedNotes: [],
        monophonicPitch: null,
        onsetPitch: null,
        error: null,
      }));
      const engine = ensureEngine();
      try {
        const started = await engine.startMicrophone(deviceId);
        if (!started || operation !== operationRef.current || !mountedRef.current) return;
        const devices = await AudioEngine.listInputs();
        if (operation !== operationRef.current || !mountedRef.current) return;
        setState((previous) => ({
          ...previous,
          status: "running",
          sourceKind: "microphone",
          devices,
          trackedNotes: [],
          onsetPitch: null,
          error: null,
        }));
        startLoop();
      } catch (error) {
        if (operation !== operationRef.current || !mountedRef.current) return;
        await engine.stop();
        if (operation !== operationRef.current || !mountedRef.current) return;
        setState((previous) => ({
          ...previous,
          status: "error",
          sourceKind: null,
          error: describeAudioError(error),
        }));
      }
    },
    [ensureEngine, resetInputDetection, startLoop, stopLoop],
  );

  const startDemo = useCallback(
    async (midis: readonly number[]) => {
      const operation = ++operationRef.current;
      stopLoop();
      trackerRef.current.reset();
      resetInputDetection();
      setState((previous) => ({
        ...previous,
        status: "requesting",
        sourceKind: null,
        observation: undefined,
        frame: null,
        waveform: null,
        trackedNotes: [],
        monophonicPitch: null,
        onsetPitch: null,
        error: null,
      }));
      const engine = ensureEngine();
      try {
        const started = await engine.startDemo(midis);
        if (!started || operation !== operationRef.current || !mountedRef.current) return;
        setState((previous) => ({
          ...previous,
          status: "running",
          sourceKind: "demo",
          trackedNotes: [],
          onsetPitch: null,
          error: null,
        }));
        startLoop();
      } catch (error) {
        if (operation !== operationRef.current || !mountedRef.current) return;
        await engine.stop();
        if (operation !== operationRef.current || !mountedRef.current) return;
        setState((previous) => ({
          ...previous,
          status: "error",
          sourceKind: null,
          error: describeAudioError(error),
        }));
      }
    },
    [ensureEngine, resetInputDetection, startLoop, stopLoop],
  );

  const startDemoSequence = useCallback(
    async (midis: readonly number[]) => {
      const operation = ++operationRef.current;
      stopLoop();
      trackerRef.current.reset();
      resetInputDetection();
      setState((previous) => ({
        ...previous,
        status: "requesting",
        sourceKind: null,
        observation: undefined,
        frame: null,
        waveform: null,
        trackedNotes: [],
        monophonicPitch: null,
        onsetPitch: null,
        error: null,
      }));
      const engine = ensureEngine();
      try {
        const started = await engine.startDemoSequence(midis);
        if (!started || operation !== operationRef.current || !mountedRef.current) return;
        setState((previous) => ({
          ...previous,
          status: "running",
          sourceKind: "demo",
          trackedNotes: [],
          onsetPitch: null,
          error: null,
        }));
        startLoop();
      } catch (error) {
        if (operation !== operationRef.current || !mountedRef.current) return;
        await engine.stop();
        if (operation !== operationRef.current || !mountedRef.current) return;
        setState((previous) => ({
          ...previous,
          status: "error",
          sourceKind: null,
          error: describeAudioError(error),
        }));
      }
    },
    [ensureEngine, resetInputDetection, startLoop, stopLoop],
  );

  const stop = useCallback(async () => {
    const operation = ++operationRef.current;
    stopLoop();
    await engineRef.current?.stop();
    if (operation !== operationRef.current || !mountedRef.current) return;
    trackerRef.current.reset();
    resetInputDetection();
    setState((previous) => ({
      ...previous,
      status: "idle",
      sourceKind: null,
      observation: undefined,
      frame: null,
      waveform: null,
      trackedNotes: [],
      monophonicPitch: null,
      onsetPitch: null,
      error: null,
    }));
  }, [resetInputDetection, stopLoop]);

  const setGain = useCallback(
    (gain: number) => {
      const previousGain = gainRef.current;
      gainRef.current = gain;
      const engine = engineRef.current;
      engine?.setGain(gain);
      const liveMicrophoneProfile =
        engine?.sourceKind === "microphone" &&
        inputProfileRef.current === "microphone";
      if (!liveMicrophoneProfile || Math.abs(gain - previousGain) < 1e-6) return;

      trackerRef.current.reset();
      resetInputDetection();
      setState((previous) => ({
        ...previous,
        observation: undefined,
        frame: null,
        waveform: null,
        trackedNotes: [],
        monophonicPitch: null,
        onsetPitch: null,
      }));
    },
    [resetInputDetection],
  );

  useEffect(() => {
    if (configKeyRef.current === configKey) return;
    configKeyRef.current = configKey;
    trackerRef.current.reset();
    resetTemporalDetection();
    setState((previous) => ({
      ...previous,
      trackedNotes: [],
      onsetPitch: null,
    }));
  }, [configKey, resetTemporalDetection]);

  useEffect(() => {
    if (inputProfileKeyRef.current === inputProfile) return;
    inputProfileKeyRef.current = inputProfile;
    engineRef.current?.setInputProfile(inputProfile);
    trackerRef.current.reset();
    resetInputDetection();
    setState((previous) => ({
      ...previous,
      observation: undefined,
      frame: null,
      waveform: null,
      trackedNotes: [],
      monophonicPitch: null,
      onsetPitch: null,
    }));
  }, [inputProfile, resetInputDetection]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
      stopLoop();
      void engineRef.current?.stop();
    };
  }, [refreshDevices, stopLoop]);

  return {
    ...state,
    startMicrophone,
    startDemo,
    startDemoSequence,
    stop,
    setGain,
  };
}

export function createAnalyzerConfig(
  overrides: Partial<AnalyzerConfig> = {},
): AnalyzerConfig {
  return { ...DEFAULT_ANALYZER_CONFIG, ...overrides };
}
