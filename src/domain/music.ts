export const NOTE_NAMES_SHARP = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
] as const;

export const NOTE_NAMES_FLAT = [
  "C",
  "D♭",
  "D",
  "E♭",
  "E",
  "F",
  "G♭",
  "G",
  "A♭",
  "A",
  "B♭",
  "B",
] as const;

export type AccidentalMode = "sharp" | "flat";

export interface DetectedNote {
  midi: number;
  pitchClass: number;
  frequency: number;
  cents: number;
  confidence: number;
  amplitude: number;
  source?: "detected" | "manual";
}

export interface ChordCandidate {
  root: number;
  definitionId: ChordDefinitionId;
  intervals: readonly number[];
  symbol: string;
  name: string;
  score: number;
  missing: number[];
  extra: number[];
}

export interface FretPosition {
  stringIndex: number;
  stringNumber: number;
  fret: number;
  midi: number;
  pitchClass: number;
}

export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64] as const;

const PITCH_COLORS = [
  "#ff6b79",
  "#ff855f",
  "#f7b955",
  "#d8d65a",
  "#9bdd69",
  "#5fd79d",
  "#48d7ce",
  "#58bff5",
  "#7f9dff",
  "#aa82f5",
  "#d376e7",
  "#ef6cae",
] as const;

export type ChordQuality =
  | "power"
  | "suspended"
  | "major"
  | "minor"
  | "dominant"
  | "diminished"
  | "half-diminished"
  | "augmented";

export interface ChordDefinition {
  /** Stable, spelling-independent identifier used by saved UI state. */
  id: string;
  intervals: readonly number[];
  symbol: string;
  name: string;
  quality: ChordQuality;
}

/**
 * Canonical chord vocabulary shared by recognition and harmonic analysis.
 * IDs are deliberately independent from localized names and rendered symbols.
 */
export const CHORD_DEFINITIONS = [
  { id: "power-5", intervals: [0, 7], symbol: "5", name: "power chord", quality: "power" },
  { id: "sus-2", intervals: [0, 2, 7], symbol: "sus2", name: "sus2", quality: "suspended" },
  { id: "minor-triad", intervals: [0, 3, 7], symbol: "m", name: "minor", quality: "minor" },
  { id: "major-triad", intervals: [0, 4, 7], symbol: "", name: "major", quality: "major" },
  { id: "sus-4", intervals: [0, 5, 7], symbol: "sus4", name: "sus4", quality: "suspended" },
  { id: "diminished-triad", intervals: [0, 3, 6], symbol: "dim", name: "diminished triad", quality: "diminished" },
  { id: "augmented-triad", intervals: [0, 4, 8], symbol: "+", name: "augmented triad", quality: "augmented" },
  { id: "major-6", intervals: [0, 4, 7, 9], symbol: "6", name: "major sixth", quality: "major" },
  { id: "minor-6", intervals: [0, 3, 7, 9], symbol: "m6", name: "minor sixth", quality: "minor" },
  { id: "dominant-7", intervals: [0, 4, 7, 10], symbol: "7", name: "dominant seventh", quality: "dominant" },
  { id: "major-7", intervals: [0, 4, 7, 11], symbol: "maj7", name: "major seventh", quality: "major" },
  { id: "minor-7", intervals: [0, 3, 7, 10], symbol: "m7", name: "minor seventh", quality: "minor" },
  { id: "minor-major-7", intervals: [0, 3, 7, 11], symbol: "m(maj7)", name: "minor major seventh", quality: "minor" },
  { id: "half-diminished-7", intervals: [0, 3, 6, 10], symbol: "m7♭5", name: "half-diminished seventh", quality: "half-diminished" },
  { id: "diminished-7", intervals: [0, 3, 6, 9], symbol: "dim7", name: "diminished seventh", quality: "diminished" },
  { id: "augmented-7", intervals: [0, 4, 8, 10], symbol: "+7", name: "augmented seventh", quality: "augmented" },
  { id: "augmented-major-7", intervals: [0, 4, 8, 11], symbol: "+maj7", name: "augmented major seventh", quality: "augmented" },
  { id: "major-add-9", intervals: [0, 2, 4, 7], symbol: "add9", name: "major add ninth", quality: "major" },
  { id: "minor-add-9", intervals: [0, 2, 3, 7], symbol: "m(add9)", name: "minor add ninth", quality: "minor" },
  { id: "dominant-9", intervals: [0, 2, 4, 7, 10], symbol: "9", name: "dominant ninth", quality: "dominant" },
  { id: "major-9", intervals: [0, 2, 4, 7, 11], symbol: "maj9", name: "major ninth", quality: "major" },
  { id: "minor-9", intervals: [0, 2, 3, 7, 10], symbol: "m9", name: "minor ninth", quality: "minor" },
  { id: "dominant-11", intervals: [0, 2, 4, 5, 7, 10], symbol: "11", name: "dominant eleventh", quality: "dominant" },
] as const satisfies readonly ChordDefinition[];

export type ChordDefinitionId = (typeof CHORD_DEFINITIONS)[number]["id"];

export function getChordDefinition(
  definitionId: ChordDefinitionId,
): (typeof CHORD_DEFINITIONS)[number] {
  const definition = CHORD_DEFINITIONS.find(({ id }) => id === definitionId);
  if (!definition) {
    // The type prevents this in application code; the guard keeps runtime input safe.
    throw new Error(`Unknown chord definition: ${definitionId}`);
  }
  return definition;
}

export function mod12(value: number): number {
  return ((value % 12) + 12) % 12;
}

export function midiToFrequency(midi: number, a4 = 440): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function frequencyToMidi(frequency: number, a4 = 440): number {
  return 69 + 12 * Math.log2(frequency / a4);
}

export function noteName(
  pitchClass: number,
  accidentalMode: AccidentalMode = "sharp",
): string {
  return (accidentalMode === "sharp" ? NOTE_NAMES_SHARP : NOTE_NAMES_FLAT)[
    mod12(pitchClass)
  ];
}

export function midiNoteName(
  midi: number,
  accidentalMode: AccidentalMode = "sharp",
): string {
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  return `${noteName(rounded, accidentalMode)}${octave}`;
}

export function pitchColor(pitchClass: number): string {
  return PITCH_COLORS[mod12(pitchClass)];
}

export function uniquePitchClasses(values: readonly number[]): number[] {
  return [...new Set(values.map(mod12))].sort((a, b) => a - b);
}

export function intervalClass(a: number, b: number): number {
  const distance = mod12(b - a);
  return Math.min(distance, 12 - distance);
}

export function intervalLabel(distance: number): string {
  return ["unison", "m2", "M2", "m3", "M3", "P4/P5", "tritone"][
    Math.max(0, Math.min(6, distance))
  ];
}

export function detectChords(
  pitchClasses: readonly number[],
  bassPitchClass?: number,
  accidentalMode: AccidentalMode = "sharp",
): ChordCandidate[] {
  const input = uniquePitchClasses(pitchClasses);
  if (input.length < 2) return [];

  const candidates: ChordCandidate[] = [];
  for (let root = 0; root < 12; root += 1) {
    for (const template of CHORD_DEFINITIONS) {
      const expected = template.intervals.map((interval) => mod12(root + interval));
      const missing = expected.filter((pitchClass) => !input.includes(pitchClass));
      const extra = input.filter((pitchClass) => !expected.includes(pitchClass));
      const rootOmitted =
        template.intervals.length >= 4 &&
        missing.length === 1 &&
        missing[0] === root &&
        input.length >= 3;

      if ((!rootOmitted && missing.length > 0) || extra.length > 1) continue;

      const exact = missing.length === 0 && extra.length === 0;
      const rootInBass = bassPitchClass !== undefined && mod12(bassPitchClass) === root;
      const coverage = expected.length / Math.max(input.length, expected.length);
      const score =
        (exact ? 100 : rootOmitted ? 62 : 76) +
        coverage * 10 +
        (rootInBass ? 5 : 0) +
        (input.includes(root) ? 2 : 0) -
        extra.length * 6;

      const slash =
        bassPitchClass !== undefined && mod12(bassPitchClass) !== root
          ? `/${noteName(bassPitchClass, accidentalMode)}`
          : "";
      candidates.push({
        root,
        definitionId: template.id,
        intervals: template.intervals,
        symbol: `${noteName(root, accidentalMode)}${template.symbol}${rootOmitted ? "(no root)" : ""}${slash}`,
        name: template.name,
        score,
        missing,
        extra,
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, 5);
}

export function buildFretboard(
  tuning: readonly number[] = STANDARD_TUNING,
  fretCount = 24,
  capo = 0,
): FretPosition[] {
  const positions: FretPosition[] = [];
  tuning.forEach((openMidi, stringIndex) => {
    for (let fret = 0; fret <= fretCount; fret += 1) {
      const midi = openMidi + capo + fret;
      positions.push({
        stringIndex,
        stringNumber: tuning.length - stringIndex,
        fret,
        midi,
        pitchClass: mod12(midi),
      });
    }
  });
  return positions;
}
