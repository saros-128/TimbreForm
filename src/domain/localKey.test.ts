import { describe, expect, it } from "vitest";
import {
  buildPitchClassHistogram,
  estimateLocalKey,
  mergePitchClassHistograms,
} from "./localKey";

describe("pitch-class histogram", () => {
  it("deduplicates octave-equivalent pitches within one onset", () => {
    const histogram = buildPitchClassHistogram([
      {
        weight: 0.8,
        pitches: [
          { pitchClass: 0, weight: 1 },
          { pitchClass: 12, weight: 0.5 },
          { pitchClass: 4, weight: 0.75 },
        ],
      },
    ]);

    expect(histogram.observationCount).toBe(1);
    expect(histogram.pitchCount).toBe(2);
    expect(histogram.bins[0]).toBeCloseTo(0.8);
    expect(histogram.bins[4]).toBeCloseTo(0.6);
    expect(histogram.normalized.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it("merges histograms with a deterministic older-bar decay", () => {
    const current = buildPitchClassHistogram([{ pitches: [{ pitchClass: 0 }] }]);
    const previous = buildPitchClassHistogram([{ pitches: [{ pitchClass: 7 }] }]);
    const merged = mergePitchClassHistograms([current, previous], [1, 0.5]);

    expect(merged.bins[0]).toBe(1);
    expect(merged.bins[7]).toBe(0.5);
    expect(merged.observationCount).toBe(2);
  });
});

describe("local key estimation", () => {
  it("ranks a repeated C-major collection first", () => {
    const histogram = buildPitchClassHistogram([
      { pitches: [{ pitchClass: 0 }] },
      { pitches: [{ pitchClass: 4 }] },
      { pitches: [{ pitchClass: 7 }] },
      { pitches: [{ pitchClass: 0 }] },
      { pitches: [{ pitchClass: 4 }] },
      { pitches: [{ pitchClass: 7 }] },
      { pitches: [{ pitchClass: 11, weight: 0.45 }] },
      { pitches: [{ pitchClass: 0 }] },
    ]);
    const estimate = estimateLocalKey(histogram);

    expect(estimate.candidates[0]).toMatchObject({
      tonicPitchClass: 0,
      mode: "major",
    });
    expect(estimate.tonic?.pitchClass).toBe(0);
    expect(estimate.confidence).toBeGreaterThan(0.2);
  });

  it("does not invent a confident key from one pitch class", () => {
    const histogram = buildPitchClassHistogram([
      { pitches: [{ pitchClass: 9 }] },
      { pitches: [{ pitchClass: 9 }] },
    ]);
    const estimate = estimateLocalKey(histogram);

    expect(estimate.status).toBe("insufficient");
    expect(estimate.candidates).toEqual([]);
    expect(estimate.tonic).toEqual({
      pitchClass: 9,
      confidence: 0.08,
      basis: "single-pitch",
    });
  });

  it("returns no tonic for an empty histogram", () => {
    const estimate = estimateLocalKey(buildPitchClassHistogram([]));
    expect(estimate).toMatchObject({
      status: "insufficient",
      confidence: 0,
      candidates: [],
      tonic: null,
    });
  });
});
