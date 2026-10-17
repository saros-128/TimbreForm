import { describe, expect, it } from "vitest";
import { createNotePhaseLayers, type PhaseLayerNote } from "./notePhaseLayers";

function mixture(
  sampleRate: number,
  length: number,
  tones: readonly { frequency: number; amplitude: number }[],
): Float32Array {
  return Float32Array.from({ length }, (_, index) =>
    tones.reduce(
      (sum, tone) =>
        sum +
        tone.amplitude *
          Math.sin((2 * Math.PI * tone.frequency * index) / sampleRate),
      0,
    ),
  );
}

function note(frequency: number, pitchClass: number): PhaseLayerNote {
  return {
    frequency,
    pitchClass,
    confidence: 0.9,
    amplitude: 0.8,
  };
}

describe("note-colored phase layers", () => {
  it("reconstructs separate layers for two tones in a mono mixture", () => {
    const sampleRate = 8_192;
    const layers = createNotePhaseLayers(
      mixture(sampleRate, 4_096, [
        { frequency: 256, amplitude: 0.8 },
        { frequency: 384, amplitude: 0.45 },
      ]),
      sampleRate,
      [note(256, 0), note(384, 7)],
      { maxHarmonics: 3 },
    );

    expect(layers.map((layer) => layer.pitchClass)).toEqual([0, 7]);
    expect(layers.every((layer) => layer.points.length > 100)).toBe(true);
    expect(layers[0].relativeEnergy).toBeGreaterThan(layers[1].relativeEnergy);
    expect(layers[0].partialCount).toBeGreaterThan(0);
  });

  it("reports a coincident harmonic as ambiguous", () => {
    const sampleRate = 8_000;
    const layers = createNotePhaseLayers(
      mixture(sampleRate, 4_000, [
        { frequency: 200, amplitude: 0.8 },
        { frequency: 400, amplitude: 0.5 },
      ]),
      sampleRate,
      [note(200, 0), note(400, 7)],
      { maxHarmonics: 2 },
    );

    expect(layers).toHaveLength(2);
    expect(layers.some((layer) => layer.ambiguousPartials > 0)).toBe(true);
  });

  it("rejects silence, invalid notes, and frequencies above the usable band", () => {
    expect(
      createNotePhaseLayers(new Float32Array(2_048), 12_000, [note(220, 9)]),
    ).toEqual([]);
    expect(
      createNotePhaseLayers(
        mixture(12_000, 2_048, [{ frequency: 220, amplitude: 1 }]),
        12_000,
        [note(Number.NaN, 0), note(5_900, 1)],
      ),
    ).toEqual([]);
  });

  it("is deterministic and caps the configured note count", () => {
    const sampleRate = 8_000;
    const samples = mixture(sampleRate, 2_000, [
      { frequency: 200, amplitude: 0.8 },
      { frequency: 300, amplitude: 0.6 },
      { frequency: 500, amplitude: 0.4 },
    ]);
    const notes = [note(200, 0), note(300, 4), note(500, 7)];
    const options = { maxNotes: 2, maxHarmonics: 2, maxPoints: 120 };

    const first = createNotePhaseLayers(samples, sampleRate, notes, options);
    const second = createNotePhaseLayers(samples, sampleRate, notes, options);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first.every((layer) => layer.points.length <= 120)).toBe(true);
  });
});
