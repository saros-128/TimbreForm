import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisFrame, SpectrumInput } from "../audio/dsp";
import {
  MICROPHONE_INPUT_PROFILE,
  type AudioInputProfileId,
} from "../audio/profile";

const mocks = vi.hoisted(() => ({
  engines: [] as Array<{
    sourceKind: "microphone" | "demo" | null;
    setInputProfile: ReturnType<typeof vi.fn>;
    startMicrophone: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../audio/audioEngine", () => {
  class FakeAudioEngine {
    static isSupported() {
      return true;
    }

    static async listInputs() {
      return [];
    }

    sourceKind: "microphone" | "demo" | null = null;
    setInputProfile = vi.fn();
    setGain = vi.fn();
    startMicrophone = vi.fn(async () => {
      this.sourceKind = "microphone";
      return true;
    });
    startDemo = vi.fn(async () => {
      this.sourceKind = "demo";
      return true;
    });
    startDemoSequence = this.startDemo;
    stop = vi.fn(async () => {
      this.sourceKind = null;
    });
    snapshot = vi.fn(
      (timestampMs: number): SpectrumInput => ({
        frequencyData: new Float32Array(4_096),
        timeData: new Float32Array(8_192),
        sampleRate: 48_000,
        fftSize: 8_192,
        timestampMs,
        capture:{clockId:"test-input",endSample:timestampMs*48,sampleRate:48000,windowSamples:8192},
      }),
    );

    constructor() {
      mocks.engines.push(this);
    }
  }

  return { AudioEngine: FakeAudioEngine };
});

const activeFrame: AnalysisFrame = {
  timestampMs: 64,
  notes: [
    {
      midi: 40,
      pitchClass: 4,
      frequency: 82.41,
      cents: 0,
      confidence: 0.9,
      amplitude: 0.8,
    },
  ],
  rawPeaks: [],
  rawChroma: Array.from({ length: 12 }, (_, index) => (index === 4 ? 1 : 0)),
  rms: 0.03,
  inputPeakDb: -8,
  peakDb: -12,
  noiseFloorDb: -50,
  signalToNoiseDb: 38,
  gated: false,
};
let analyzedFrame = activeFrame;

const noiseFrame: AnalysisFrame = {
  ...activeFrame,
  notes: [],
  rawChroma: Array.from({ length: 12 }, () => 0),
  rms: 0.003,
  signalToNoiseDb: 5,
};

vi.mock("../audio/dsp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audio/dsp")>();
  return {
    ...actual,
    analyzeSpectrum: vi.fn(() => analyzedFrame),
  };
});

import { createAnalyzerConfig, useHarmonicAudio } from "./useHarmonicAudio";

describe("useHarmonicAudio input profiles", () => {
  let callbacks: FrameRequestCallback[];

  beforeEach(() => {
    callbacks = [];
    mocks.engines = [];
    analyzedFrame = activeFrame;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears temporal output on a profile switch without restarting the stream", async () => {
    const config = createAnalyzerConfig();
    const { result, rerender } = renderHook(
      ({ profile }: { profile: AudioInputProfileId }) =>
        useHarmonicAudio(config, profile),
      { initialProps: { profile: "clean" as AudioInputProfileId } },
    );

    await act(async () => {
      await result.current.startMicrophone("input-1");
    });
    expect(mocks.engines).toHaveLength(1);
    expect(mocks.engines[0].startMicrophone).toHaveBeenCalledOnce();

    act(() => {
      callbacks.shift()?.(64);
    });
    expect(result.current.frame).toBe(analyzedFrame);
    expect(result.current.waveform).not.toBeNull();

    rerender({ profile: "microphone" });

    expect(result.current.frame).toBeNull();
    expect(result.current.waveform).toBeNull();
    expect(result.current.trackedNotes).toEqual([]);
    expect(result.current.onsetPitch).toBeNull();
    expect(mocks.engines[0].setInputProfile).toHaveBeenLastCalledWith("microphone");
    expect(mocks.engines[0].startMicrophone).toHaveBeenCalledOnce();
  });

  it("publishes an owned, downsampled waveform and clears it on stop", async () => {
    const input = Float32Array.from({ length: 8_192 }, (_, index) => index % 8);
    const snapshot: SpectrumInput = {
      frequencyData: new Float32Array(4_096),
      timeData: input,
      sampleRate: 48_000,
      fftSize: 8_192,
      timestampMs: 64,
      capture:{clockId:"owned-input",endSample:96000,sampleRate:48000,windowSamples:8192},
    };
    const { result } = renderHook(() =>
      useHarmonicAudio(createAnalyzerConfig(), "clean"),
    );
    await act(async () => {
      await result.current.startMicrophone("input-1");
    });
    mocks.engines[0].snapshot.mockReturnValue(snapshot);

    act(() => callbacks.shift()?.(64));

    expect(result.current.observation?.capture).toEqual(snapshot.capture);
    expect(result.current.observation?.deliveredAtMs).toBe(64);
    expect(result.current.observation?.origin).toBe("captured");
    expect(result.current.waveform?.samples).toHaveLength(2_048);
    expect(result.current.waveform?.sampleRate).toBe(12_000);
    expect(result.current.waveform?.timestampMs).toBe(64);
    expect(result.current.waveform?.samples).not.toBe(input);
    expect(result.current.waveform?.samples[0]).toBeCloseTo(1.5);
    input.fill(99);
    expect(result.current.waveform?.samples[0]).toBeCloseTo(1.5);

    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.waveform).toBeNull();
  });

  it("keeps room calibration across analyzer-config changes", async () => {
    const { result, rerender } = renderHook(
      ({ config }) => useHarmonicAudio(config, "microphone"),
      { initialProps: { config: createAnalyzerConfig() } },
    );
    await act(async () => {
      await result.current.startMicrophone("input-1");
    });

    analyzedFrame = noiseFrame;
    for (
      let index = 1;
      index <= MICROPHONE_INPUT_PROFILE.calibrationFrames;
      index += 1
    ) {
      act(() => callbacks.shift()?.(index * 40));
    }
    analyzedFrame = activeFrame;
    const activeAt = (MICROPHONE_INPUT_PROFILE.calibrationFrames + 1) * 40;
    act(() => callbacks.shift()?.(activeAt));
    expect(result.current.frame?.gated).toBe(false);

    rerender({ config: createAnalyzerConfig({ maxPolyphony: 3 }) });
    act(() => callbacks.shift()?.(activeAt + 40));

    expect(result.current.frame?.gated).toBe(false);
    expect(mocks.engines[0].startMicrophone).toHaveBeenCalledOnce();
  });

  it("invalidates microphone calibration when live gain changes", async () => {
    const { result } = renderHook(() =>
      useHarmonicAudio(createAnalyzerConfig(), "microphone"),
    );
    await act(async () => {
      await result.current.startMicrophone("input-1");
    });

    analyzedFrame = noiseFrame;
    for (
      let index = 1;
      index <= MICROPHONE_INPUT_PROFILE.calibrationFrames;
      index += 1
    ) {
      act(() => callbacks.shift()?.(index * 40));
    }
    analyzedFrame = activeFrame;
    const activeAt = (MICROPHONE_INPUT_PROFILE.calibrationFrames + 1) * 40;
    act(() => callbacks.shift()?.(activeAt));
    expect(result.current.frame?.gated).toBe(false);

    act(() => result.current.setGain(2));
    expect(result.current.frame).toBeNull();
    act(() => callbacks.shift()?.(activeAt + 40));

    expect(result.current.frame?.gated).toBe(true);
    expect(mocks.engines[0].startMicrophone).toHaveBeenCalledOnce();
  });
});
