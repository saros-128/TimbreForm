import { describe, expect, it } from "vitest";
import type { AnalysisFrame } from "./dsp";
import {
  AdaptiveRoomNoiseGate,
  applyAudioInputProfile,
  audioInputProfileAllowsOnset,
  createLiveAnalyzerOverrides,
  DEFAULT_UI_SENSITIVITY,
  MICROPHONE_INPUT_PROFILE,
  resolveAudioInputProfile,
} from "./profile";

function analysisFrame(
  rms: number,
  signalToNoiseDb: number,
  gated = false,
): AnalysisFrame {
  return {
    timestampMs: 0,
    notes: [
      {
        midi: 40,
        pitchClass: 4,
        frequency: 82.41,
        cents: 0,
        confidence: 0.8,
        amplitude: 0.5,
      },
    ],
    rawPeaks: [],
    rawChroma: Array.from({ length: 12 }, (_, index) => (index === 4 ? 1 : 0)),
    rms,
    inputPeakDb: -12,
    peakDb: -20,
    noiseFloorDb: -50,
    signalToNoiseDb,
    gated,
  };
}

describe("product Live analyzer profiles", () => {
  it("keeps the default stable UI settings explicit", () => {
    expect(createLiveAnalyzerOverrides("stable", 4, DEFAULT_UI_SENSITIVITY)).toEqual({
      maxPolyphony: 4,
      minConfidence: 0.26,
      minSignalToNoiseDb: 11,
      minRms: 0.00185,
      harmonicSuppression: 0.86,
      nnlsWeight: 0.1,
    });
  });

  it("keeps responsive beta tuning separate while sharing the signal gate", () => {
    expect(createLiveAnalyzerOverrides("responsive", 3, DEFAULT_UI_SENSITIVITY)).toEqual({
      maxPolyphony: 3,
      minConfidence: 0.17,
      minSignalToNoiseDb: 11,
      minRms: 0.00185,
      harmonicSuppression: 0.98,
      nnlsWeight: 0.32,
    });
  });

  it("clamps sensitivity to the UI range", () => {
    expect(createLiveAnalyzerOverrides("stable", 2, 150)).toEqual(
      createLiveAnalyzerOverrides("stable", 2, 100),
    );
    expect(createLiveAnalyzerOverrides("stable", 2, -10)).toEqual(
      createLiveAnalyzerOverrides("stable", 2, 0),
    );
  });

  it("opens the RMS gate as sensitivity increases", () => {
    const quiet = createLiveAnalyzerOverrides("stable", 4, 10).minRms;
    const normal = createLiveAnalyzerOverrides("stable", 4, 50).minRms;
    const sensitive = createLiveAnalyzerOverrides("stable", 4, 90).minRms;
    expect(quiet).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(sensitive);
    expect(sensitive).toBeCloseTo(0.00085, 8);
  });
});

describe("audio input signal profiles", () => {
  it("keeps clean DI analysis as an exact identity operation", () => {
    const frame = analysisFrame(0.02, 18);
    expect(
      applyAudioInputProfile("clean", frame, new AdaptiveRoomNoiseGate()),
    ).toBe(frame);
  });

  it("bypasses microphone processing for demo audio", () => {
    expect(resolveAudioInputProfile("microphone", "demo")).toBe("clean");
    expect(resolveAudioInputProfile("microphone", "microphone")).toBe("microphone");
  });

  it("blocks a pending microphone onset when the room gate has closed", () => {
    expect(audioInputProfileAllowsOnset("microphone", true)).toBe(false);
    expect(audioInputProfileAllowsOnset("microphone", false)).toBe(true);
    expect(audioInputProfileAllowsOnset("clean", true)).toBe(true);
  });

  it("calibrates on room noise and opens only for a signal above the learned floor", () => {
    const gate = new AdaptiveRoomNoiseGate();
    let noise = analysisFrame(0.005, 5);
    for (let index = 0; index < MICROPHONE_INPUT_PROFILE.calibrationFrames; index += 1) {
      noise = gate.process(noise);
      expect(noise.gated).toBe(true);
      expect(noise.notes).toEqual([]);
    }

    const state = gate.update({ rms: 0.005, signalToNoiseDb: 5, gated: false });
    expect(state.calibrated).toBe(true);
    expect(state.ambientRmsDb).toBeCloseTo(20 * Math.log10(0.005), 5);

    const signal = gate.process(analysisFrame(0.03, 18));
    expect(signal.gated).toBe(false);
    expect(signal.notes).toHaveLength(1);
  });

  it("never bootstrap-opens on loud uncalibrated frames", () => {
    const gate = new AdaptiveRoomNoiseGate();
    for (let index = 0; index < MICROPHONE_INPUT_PROFILE.calibrationFrames; index += 1) {
      const state = gate.update({ rms: 0.05, signalToNoiseDb: 25, gated: false });
      expect(state.gated).toBe(true);
    }
    expect(gate.update({ rms: 0.05, signalToNoiseDb: 25, gated: false }).gated).toBe(
      true,
    );

    // Once an actual room floor is observed, a new active signal can open.
    for (let index = 0; index < 12; index += 1) {
      expect(gate.update({ rms: 0.002, signalToNoiseDb: 5, gated: false }).gated).toBe(
        true,
      );
    }
    expect(gate.update({ rms: 0.05, signalToNoiseDb: 25, gated: false }).gated).toBe(
      false,
    );
  });

  it("uses hysteresis for short gaps and closes after the release hold", () => {
    const gate = new AdaptiveRoomNoiseGate();
    for (let index = 0; index < MICROPHONE_INPUT_PROFILE.calibrationFrames; index += 1) {
      gate.process(analysisFrame(0.005, 5));
    }
    expect(gate.process(analysisFrame(0.03, 18)).gated).toBe(false);

    for (let index = 0; index < MICROPHONE_INPUT_PROFILE.releaseFrames; index += 1) {
      expect(gate.process(analysisFrame(0.005, 5)).gated).toBe(false);
    }
    expect(gate.process(analysisFrame(0.005, 5)).gated).toBe(true);
  });

  it("forces release after a sustained large drop and relearns that floor", () => {
    const gate = new AdaptiveRoomNoiseGate();
    for (let index = 0; index < MICROPHONE_INPUT_PROFILE.calibrationFrames; index += 1) {
      gate.update({ rms: 0.003, signalToNoiseDb: 5, gated: false });
    }
    expect(gate.update({ rms: 0.05, signalToNoiseDb: 25, gated: false }).gated).toBe(
      false,
    );

    let quietState = gate.update({ rms: 0.003, signalToNoiseDb: 18, gated: false });
    for (let index = 0; index < MICROPHONE_INPUT_PROFILE.releaseFrames; index += 1) {
      quietState = gate.update({ rms: 0.003, signalToNoiseDb: 18, gated: false });
    }
    expect(quietState.gated).toBe(true);
    expect(quietState.ambientRmsDb).toBeCloseTo(20 * Math.log10(0.003), 5);

    expect(gate.update({ rms: 0.05, signalToNoiseDb: 25, gated: false }).gated).toBe(
      false,
    );
  });

  it("forgets calibration and open state on reset", () => {
    const gate = new AdaptiveRoomNoiseGate();
    for (let index = 0; index < MICROPHONE_INPUT_PROFILE.calibrationFrames; index += 1) {
      gate.update({ rms: 0.005, signalToNoiseDb: 5, gated: false });
    }
    expect(gate.update({ rms: 0.03, signalToNoiseDb: 18, gated: false }).gated).toBe(false);

    gate.reset();
    const state = gate.update({ rms: 0.005, signalToNoiseDb: 5, gated: false });
    expect(state.calibrated).toBe(false);
    expect(state.gated).toBe(true);
  });
});
