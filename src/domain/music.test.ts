import { describe, expect, it } from "vitest";
import {
  CHORD_DEFINITIONS,
  buildFretboard,
  detectChords,
  frequencyToMidi,
  midiToFrequency,
  noteName,
} from "./music";

describe("music domain", () => {
  it("converts MIDI and frequency around A4", () => {
    expect(midiToFrequency(69)).toBeCloseTo(440, 8);
    expect(midiToFrequency(40)).toBeCloseTo(82.4069, 3);
    expect(frequencyToMidi(440)).toBeCloseTo(69, 8);
  });

  it("maps every fret position to the correct pitch class", () => {
    const board = buildFretboard(undefined, 24);
    expect(board).toHaveLength(6 * 25);
    expect(board.find((position) => position.stringNumber === 6 && position.fret === 0)).toMatchObject({
      midi: 40,
      pitchClass: 4,
    });
    expect(board.find((position) => position.stringNumber === 6 && position.fret === 12)).toMatchObject({
      midi: 52,
      pitchClass: 4,
    });
  });

  it("ranks exact extended chord matches first", () => {
    expect(detectChords([0, 4, 7, 11], 0)[0]).toMatchObject({
      symbol: "Cmaj7",
      definitionId: "major-7",
      intervals: [0, 4, 7, 11],
    });
    expect(detectChords([6, 9, 0, 4], 6)[0]?.symbol).toBe("F♯m7♭5");
  });

  it("exports unique stable definitions and keeps diminished forms distinct", () => {
    expect(new Set(CHORD_DEFINITIONS.map(({ id }) => id)).size).toBe(
      CHORD_DEFINITIONS.length,
    );
    expect(
      CHORD_DEFINITIONS.find(({ id }) => id === "diminished-triad"),
    ).toMatchObject({ intervals: [0, 3, 6], quality: "diminished" });
    expect(
      CHORD_DEFINITIONS.find(({ id }) => id === "diminished-7"),
    ).toMatchObject({ intervals: [0, 3, 6, 9], quality: "diminished" });
    expect(CHORD_DEFINITIONS.find(({ id }) => id === "major-6")?.name).toBe(
      "мажор с добавленной секстой",
    );
    expect(CHORD_DEFINITIONS.find(({ id }) => id === "minor-6")?.name).toBe(
      "минор с добавленной секстой",
    );
    expect(
      CHORD_DEFINITIONS.find(({ id }) => id === "dominant-11")?.intervals,
    ).toEqual([0, 2, 4, 5, 7, 10]);
  });

  it("keeps plausible rootless extended interpretations as lower-ranked alternatives", () => {
    const candidates = detectChords([6, 9, 0, 4], 6);
    expect(candidates[0]?.symbol).toBe("F♯m7♭5");
    expect(candidates.some((candidate) => candidate.symbol.startsWith("D9(no root)"))).toBe(true);
  });

  it("supports flat note spelling", () => {
    expect(noteName(1, "sharp")).toBe("C♯");
    expect(noteName(1, "flat")).toBe("D♭");
  });
});
