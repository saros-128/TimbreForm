import { describe, expect, it } from "vitest";
import { buildPhaseContourMesh } from "./phaseContourMesh";
import { createNotePhaseLayers } from "../audio/notePhaseLayers";

function trace(period = 48, turns = 6, bend = false) {
  const length = Math.ceil(period * turns);
  return {
    x: Float32Array.from({ length }, (_, index) => {
      const phase = (2 * Math.PI * index) / period;
      return Math.cos(phase) + (bend ? 0.28 * Math.cos(3 * phase) : 0);
    }),
    y: Float32Array.from({ length }, (_, index) => {
      const phase = (2 * Math.PI * index) / period;
      return Math.sin(phase) + (bend ? 0.3 * Math.sin(2 * phase) : 0);
    }),
  };
}

describe("phase contour correspondence", () => {
  it("connects existing points one turn apart, including the sharp repeated contour", () => {
    const input = trace(48, 6, true);
    const mesh = buildPhaseContourMesh(input);
    expect(mesh.periodSamples).toBeCloseTo(48, 0);
    expect(mesh.confidence).toBeGreaterThan(0.97);
    expect(mesh.bridges.length).toBeGreaterThan(10);
    expect(mesh.quads.length).toBeGreaterThan(100);
    for (const [left, right] of mesh.bridges) {
      expect(right - left).toBe(48);
      expect(input.x[right]).toBeCloseTo(input.x[left], 5);
      expect(input.y[right]).toBeCloseTo(input.y[left], 5);
    }
    for (const [a, b, c, d] of mesh.quads) {
      expect(b).toBeGreaterThan(a);
      expect(d - a).toBe(48);
      expect(c - b).toBe(48);
      expect(c).toBeLessThan(input.x.length);
    }
  });

  it("uses sparse rendered indices, without inventing projected vertices", () => {
    const input = trace(60, 8, true);
    const sampleIndices = Array.from({ length: 160 }, (_, index) => index * 3);
    const mesh = buildPhaseContourMesh({ ...input, sampleIndices });
    expect(mesh.bridges.length).toBeGreaterThan(10);
    for (const pair of mesh.bridges) {
      expect(
        pair.every(
          (index) =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < sampleIndices.length,
        ),
      ).toBe(true);
      expect(sampleIndices[pair[1]] - sampleIndices[pair[0]]).toBe(60);
    }
    expect(
      mesh.quads.flat().every((index) => index < sampleIndices.length),
    ).toBe(true);
  });

  it("marks the repeated tips of a diamond, not arbitrary nearest neighbors at crossings", () => {
    const period = 64;
    const wave = (index: number) =>
      (2 / Math.PI) * Math.asin(Math.sin((2 * Math.PI * index) / period));
    const input = {
      x: Float32Array.from({ length: 384 }, (_, index) => wave(index)),
      y: Float32Array.from({ length: 384 }, (_, index) =>
        wave(index + period / 4),
      ),
    };
    const mesh = buildPhaseContourMesh(input);
    expect(mesh.bridges.length).toBeGreaterThan(10);
    const phases = new Set(mesh.bridges.map(([index]) => index % period));
    expect(
      [...phases].every((phase) =>
        [0, 16, 32, 48].some((tip) => Math.abs(phase - tip) <= 1),
      ),
    ).toBe(true);
  });

  it("fits a fractional period and retains correspondence through slow amplitude drift", () => {
    const input = trace(37.6, 9, true);
    for (let index = 0; index < input.x.length; index += 1) {
      input.x[index] *= 0.9 + (0.2 * index) / input.x.length;
      input.y[index] *= 0.9 + (0.2 * index) / input.x.length;
    }
    const mesh = buildPhaseContourMesh(input);
    expect(mesh.periodSamples).toBeCloseTo(37.6, 0);
    expect(mesh.bridges.length).toBeGreaterThan(10);
    for (const [left, right] of mesh.bridges)
      expect(Math.abs(right - left - 37.6)).toBeLessThan(1);
  });

  it("preserves correspondence with DC offset and uniform gain", () => {
    const source = trace(48, 6, true);
    const shifted = {
      x: Float32Array.from(source.x, (value) => value * 3 + 10),
      y: Float32Array.from(source.y, (value) => value * 3 - 4),
    };
    expect(buildPhaseContourMesh(shifted).bridges).toEqual(
      buildPhaseContourMesh(source).bridges,
    );
  });

  it("does not close the two ends of a captured window or invent a final full turn", () => {
    const source = trace(40, 5.4, true);
    const mesh = buildPhaseContourMesh(source);
    expect(mesh.quads.length).toBeGreaterThan(0);
    for (const [left, right] of mesh.bridges) {
      expect(right).toBeGreaterThan(left);
      expect(right).toBeLessThan(source.x.length);
      expect(right - left).toBe(40);
    }
    expect(
      mesh.quads.flat().every((index) => index >= 0 && index < source.x.length),
    ).toBe(true);
    expect(
      mesh.bridges.some(([a, b]) => a === 0 && b === source.x.length - 1),
    ).toBe(false);
  });

  it("rejects silence, an isolated curve, a monotone stroke and deterministic noise", () => {
    let seed = 913;
    const noise = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 2 ** 32 - 0.5;
    };
    const inputs = [
      { x: new Float32Array(256), y: new Float32Array(256) },
      trace(128, 1.4),
      {
        x: Float32Array.from({ length: 256 }, (_, index) => index / 256),
        y: Float32Array.from({ length: 256 }, (_, index) => (index / 256) ** 2),
      },
      {
        x: Float32Array.from({ length: 512 }, noise),
        y: Float32Array.from({ length: 512 }, noise),
      },
    ];
    for (const input of inputs) {
      const mesh = buildPhaseContourMesh(input);
      expect(mesh.periodSamples).toBeNull();
      expect(mesh.bridges).toEqual([]);
      expect(mesh.quads).toEqual([]);
    }
  });

  it("rejects unrelated branches when only one coordinate repeats", () => {
    const input = trace(32, 8);
    input.y = Float32Array.from(
      { length: input.x.length },
      (_, index) => index / 30,
    );
    expect(buildPhaseContourMesh(input).bridges).toEqual([]);
  });

  it("stays bounded for long traces and caller budgets", () => {
    const mesh = buildPhaseContourMesh({
      ...trace(128, 32, true),
      maxBridges: 24,
      maxFaces: 90,
    });
    expect(mesh.bridges.length).toBeGreaterThan(0);
    expect(mesh.bridges.length).toBeLessThanOrEqual(24);
    expect(mesh.quads.length).toBeGreaterThan(0);
    expect(mesh.quads.length).toBeLessThanOrEqual(90);
    const disabled = buildPhaseContourMesh({
      ...trace(),
      maxBridges: 0,
      maxFaces: 0,
    });
    expect(disabled.bridges).toEqual([]);
    expect(disabled.quads).toEqual([]);
  });

  it("connects the actual full-window note reconstruction for a guitar chord", () => {
    const sampleRate = 48_000;
    const frequencies = [130.8128, 164.8138, 195.9977];
    const signal = Float32Array.from({ length: 4096 }, (_, index) =>
      frequencies.reduce((sum, frequency) => {
        const phase = (2 * Math.PI * frequency * index) / sampleRate;
        return (
          sum +
          0.2 * Math.sin(phase) +
          0.06 * Math.sin(2 * phase) +
          0.03 * Math.sin(3 * phase)
        );
      }, 0),
    );
    const layers = createNotePhaseLayers(
      signal,
      sampleRate,
      frequencies.map((frequency, index) => ({
        frequency,
        pitchClass: [0, 4, 7][index],
        confidence: 0.95,
        amplitude: 0.8,
      })),
      { maxHarmonics: 6, maxPoints: 480 },
    );
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      const input = {
        x: layer.points.map((point) => point.x),
        y: layer.points.map((point) => point.y),
      };
      const mesh = buildPhaseContourMesh(input);
      // This is the same 480-point reconstruction used by the existing scope,
      // not a replacement oscillator or cropped one-cycle window.
      expect(input.x).toHaveLength(480);
      expect(mesh.confidence).toBeGreaterThan(0.9);
      expect(mesh.bridges.length).toBeGreaterThan(8);
      expect(mesh.quads.length).toBeGreaterThan(100);
      for (const [a, b] of mesh.bridges) {
        expect(
          Math.hypot(input.x[a] - input.x[b], input.y[a] - input.y[b]),
        ).toBeLessThan(0.4);
      }
    }
  });

  it("returns no topology for unusable or excessively sparse render paths", () => {
    const input = trace();
    expect(
      buildPhaseContourMesh({ ...input, sampleIndices: [0, 10, 4] }).bridges,
    ).toEqual([]);
    expect(buildPhaseContourMesh({ x: [], y: [] }).quads).toEqual([]);
    const corrupt = trace();
    corrupt.x[30] = Number.NaN;
    expect(buildPhaseContourMesh(corrupt).quads).toEqual([]);
    expect(buildPhaseContourMesh(trace(4, 60)).bridges).toEqual([]);
    const sparse = buildPhaseContourMesh({
      ...trace(24, 12),
      sampleIndices: Array.from({ length: 12 }, (_, index) => index * 24),
    });
    expect(sparse.bridges).toEqual([]);
    expect(sparse.quads).toEqual([]);
  });
});
