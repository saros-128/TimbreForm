import { describe, expect, it } from "vitest";
import {
  analyzeSpectrum,
  DEFAULT_ANALYZER_CONFIG,
  estimateMonophonicPitch,
  positiveDifferenceSpectrum,
  positiveSpectralFlux,
} from "./dsp";
import { syntheticFrame, syntheticWave } from "../test/signalFactory";
import { frequencyToMidi } from "../domain/music";

function detectedPitchClasses(midis: readonly number[], maxPolyphony = midis.length) {
  const result = analyzeSpectrum(syntheticFrame(midis), {
    ...DEFAULT_ANALYZER_CONFIG,
    maxPolyphony,
    minConfidence: 0.18,
  });
  return result.notes.map((note) => note.pitchClass);
}

describe("spectral note reduction", () => {
  it("keeps a single guitar note and suppresses its harmonic pitch classes", () => {
    const pitchClasses = detectedPitchClasses([40], 4);
    expect(pitchClasses[0]).toBe(4);
    expect(new Set(pitchClasses)).toEqual(new Set([4]));
  });

  it("recovers a minor triad from a harmonic spectrum", () => {
    expect(new Set(detectedPitchClasses([45, 52, 60], 3))).toEqual(new Set([9, 4, 0]));
  });

  it("recovers the four pitch classes in E minor-major seven", () => {
    expect(new Set(detectedPitchClasses([40, 55, 59, 63], 4))).toEqual(
      new Set([4, 7, 11, 3]),
    );
  });

  it("gates silence", () => {
    const frame = syntheticFrame([]);
    const result = analyzeSpectrum(frame, DEFAULT_ANALYZER_CONFIG);
    expect(result.gated).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("isolates a newly plucked note from an already sounding note", () => {
    const before = syntheticFrame([40]);
    const after = syntheticFrame([40, 55]);
    const difference = positiveDifferenceSpectrum(after.frequencyData, before.frequencyData);
    const result = analyzeSpectrum(
      { ...after, frequencyData: difference },
      {
        ...DEFAULT_ANALYZER_CONFIG,
        maxPolyphony: 1,
        minConfidence: 0.16,
      },
    );
    expect(result.notes[0]?.pitchClass).toBe(7);
    expect(
      positiveSpectralFlux(
        after.frequencyData,
        before.frequencyData,
        after.sampleRate,
        after.fftSize,
      ),
    ).toBeGreaterThan(0.1);
  });

  it("keeps MIDI, refined frequency, pitch class, and cents internally consistent", () => {
    const result = analyzeSpectrum(syntheticFrame([40, 41]), {
      ...DEFAULT_ANALYZER_CONFIG,
      maxPolyphony: 2,
      minConfidence: 0.16,
    });
    for (const note of result.notes) {
      expect(note.pitchClass).toBe(((note.midi % 12) + 12) % 12);
      expect((frequencyToMidi(note.frequency) - note.midi) * 100).toBeCloseTo(
        note.cents,
        5,
      );
    }
  });
});

describe("monophonic YIN validator", () => {
  it("detects A3 within a few cents", () => {
    const result = estimateMonophonicPitch(syntheticWave([57], { length: 8192 }), 48_000);
    expect(result).not.toBeNull();
    expect(result?.note.midi).toBe(57);
    expect(Math.abs(result?.note.cents ?? 99)).toBeLessThan(3);
    expect(result?.clarity).toBeGreaterThan(0.9);
  });

  it("keeps the YIN duration and result stable across common interface rates", () => {
    for (const sampleRate of [44_100, 48_000, 96_000, 192_000]) {
      const result = estimateMonophonicPitch(
        syntheticWave([57], {
          sampleRate,
          length: Math.round(sampleRate * 0.1),
        }),
        sampleRate,
      );
      expect(result?.note.midi, `${sampleRate} Hz`).toBe(57);
      expect(Math.abs(result?.note.cents ?? 99), `${sampleRate} Hz`).toBeLessThan(4);
    }
  });
});
