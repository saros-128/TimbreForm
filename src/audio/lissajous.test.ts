import { describe, expect, it } from "vitest";
import {
  createHarmonicLissajousPoints,
  createPhasePortraitPoints,
  resolveLissajousRatio,
  resolvePhasePortraitDelay,
} from "./lissajous";

describe("microphone phase portrait", () => {
  it("derives a quarter-period delay from a detected fundamental", () => {
    expect(resolvePhasePortraitDelay({ sampleRate: 48_000, frequencyHz: 1_000 })).toBe(
      12,
    );
    expect(
      resolvePhasePortraitDelay({
        sampleRate: 48_000,
        frequencyHz: 1_000,
        delaySamples: 7,
      }),
    ).toBe(7);
    expect(resolvePhasePortraitDelay({ sampleRate: 12_000 })).toBe(12);
  });

  it("turns a sine wave and its quarter-period delay into a normalized circle", () => {
    const sampleRate = 400;
    const frequencyHz = 10;
    const samples = Float32Array.from({ length: 200 }, (_, index) =>
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate),
    );

    const points = createPhasePortraitPoints(samples, {
      sampleRate,
      frequencyHz,
      maxPoints: samples.length,
    });

    expect(points).toHaveLength(190);
    for (const point of points) {
      expect(point.x * point.x + point.y * point.y).toBeCloseTo(1, 5);
    }
  });

  it("centers, normalizes, and evenly downsamples the waveform", () => {
    const points = createPhasePortraitPoints(Float32Array.of(-1, -0.5, 0, 0.5, 1), {
      sampleRate: 48_000,
      delaySamples: 2,
      maxPoints: 2,
    });

    expect(points).toEqual([
      { x: 0, y: -1 },
      { x: 1, y: 0 },
    ]);
  });

  it("returns no path for an empty or single-sample frame", () => {
    expect(createPhasePortraitPoints(new Float32Array(), { sampleRate: 48_000 })).toEqual(
      [],
    );
    expect(createPhasePortraitPoints(Float32Array.of(0.5), { sampleRate: 48_000 })).toEqual(
      [],
    );
  });
});

describe("clean harmonic Lissajous curve", () => {
  it("reduces two frequencies to a small stable ratio", () => {
    expect(resolveLissajousRatio([440, 660])).toEqual({ x: 2, y: 3 });
    expect(resolveLissajousRatio([880, 528])).toEqual({ x: 5, y: 3 });
    expect(resolveLissajousRatio([Number.NaN, 440])).toEqual({ x: 1, y: 1 });
  });

  it("generates a deterministic, normalized, closed path", () => {
    const options = {
      ratio: [2, 3] as const,
      pointCount: 101,
      relativePhaseRadians: Math.PI / 2,
    };
    const first = createHarmonicLissajousPoints(options);
    const second = createHarmonicLissajousPoints(options);

    expect(first).toEqual(second);
    expect(first).toHaveLength(101);
    expect(first.at(-1)).toEqual(first[0]);
    expect(first[0].x).toBeCloseTo(0, 12);
    expect(first[0].y).toBeCloseTo(1, 12);
    for (const point of first) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(1);
    }
  });

  it("supports frequency input and a continuous shared phase", () => {
    const points = createHarmonicLissajousPoints({
      frequenciesHz: [440, 660],
      pointCount: 81,
      phaseRadians: Math.PI / 8,
    });

    expect(points).toHaveLength(81);
    expect(points[0].x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(points[0].y).toBeCloseTo(Math.sin(Math.PI / 8), 12);
    expect(points.at(-1)).toEqual(points[0]);
  });
});
