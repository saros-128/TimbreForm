import { describe, expect, it } from "vitest";
import type { DetectedNote } from "../domain/music";
import { selectOnsetNote, shouldStartOnset } from "./onset";

function note(pitchClass: number, confidence: number): DetectedNote {
  return {
    midi: 60 + pitchClass,
    pitchClass,
    frequency: 440,
    cents: 0,
    confidence,
    amplitude: 1,
  };
}

describe("selectOnsetNote", () => {
  it("merges matching spectral and YIN evidence", () => {
    const selected = selectOnsetNote(
      note(7, 0.62),
      { note: note(7, 0.8), clarity: 0.9 },
      true,
    );
    expect(selected).toMatchObject({ pitchClass: 7, confidence: 0.8 });
  });

  it("keeps onset delta when YIN disagrees over held notes", () => {
    const selected = selectOnsetNote(
      note(11, 0.64),
      { note: note(4, 0.98), clarity: 0.99 },
      true,
    );
    expect(selected?.pitchClass).toBe(11);
  });

  it("uses clear YIN for an isolated onset", () => {
    const selected = selectOnsetNote(
      note(6, 0.45),
      { note: note(7, 0.82), clarity: 0.91 },
      false,
    );
    expect(selected?.pitchClass).toBe(7);
  });
});

describe("shouldStartOnset", () => {
  it("accepts strong spectral flux when RMS is stable", () => {
    expect(
      shouldStartOnset({
        flux: 0.11,
        threshold: 0.06,
        rms: 0.049,
        previousRms: 0.05,
        elapsedSinceLastOnsetMs: 400,
      }),
    ).toBe(true);
  });

  it("rejects a normalized-flux spike during steep release", () => {
    expect(
      shouldStartOnset({
        flux: 0.106,
        threshold: 0.058,
        rms: 0.0388,
        previousRms: 0.0462,
        elapsedSinceLastOnsetMs: 448,
      }),
    ).toBe(false);
  });

  it("keeps a quiet held-note onset when the absolute RMS drop is negligible", () => {
    expect(
      shouldStartOnset({
        flux: 0.11,
        threshold: 0.06,
        rms: 0.0084,
        previousRms: 0.01,
        elapsedSinceLastOnsetMs: 400,
      }),
    ).toBe(true);
  });
});
