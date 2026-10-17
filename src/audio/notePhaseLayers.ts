import { createPhasePortraitPoints, type LissajousPoint } from "./lissajous";

export interface PhaseLayerNote {
  frequency: number;
  pitchClass: number;
  confidence: number;
  amplitude: number;
}

export interface NotePhaseLayer {
  pitchClass: number;
  frequency: number;
  confidence: number;
  relativeEnergy: number;
  partialCount: number;
  ambiguousPartials: number;
  points: LissajousPoint[];
}

export interface NotePhaseLayerOptions {
  maxNotes?: number;
  maxHarmonics?: number;
  maxFrequency?: number;
  maxPoints?: number;
  minRelativeEnergy?: number;
}

interface PartialCandidate {
  noteIndex: number;
  harmonic: number;
  frequency: number;
}

const TWO_PI = Math.PI * 2;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    energy += samples[index] * samples[index];
  }
  return Math.sqrt(energy / samples.length);
}

function projectPartial(
  samples: Float32Array,
  window: Float32Array,
  windowSum: number,
  sampleRate: number,
  frequency: number,
): { cosine: number; sine: number; amplitude: number } {
  const phaseStep = (TWO_PI * frequency) / sampleRate;
  const stepCosine = Math.cos(phaseStep);
  const stepSine = Math.sin(phaseStep);
  let phaseCosine = 1;
  let phaseSine = 0;
  let cosineSum = 0;
  let sineSum = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const weighted = samples[index] * window[index];
    cosineSum += weighted * phaseCosine;
    sineSum += weighted * phaseSine;
    const nextCosine =
      phaseCosine * stepCosine - phaseSine * stepSine;
    phaseSine = phaseSine * stepCosine + phaseCosine * stepSine;
    phaseCosine = nextCosine;
  }

  const projectionScale = 2 / Math.max(windowSum, Number.EPSILON);
  const cosine = cosineSum * projectionScale;
  const sine = sineSum * projectionScale;
  return {
    cosine,
    sine,
    amplitude: Math.hypot(cosine, sine),
  };
}

function addPartial(
  target: Float32Array,
  sampleRate: number,
  frequency: number,
  cosineCoefficient: number,
  sineCoefficient: number,
  gain: number,
) {
  const phaseStep = (TWO_PI * frequency) / sampleRate;
  const stepCosine = Math.cos(phaseStep);
  const stepSine = Math.sin(phaseStep);
  let phaseCosine = 1;
  let phaseSine = 0;

  for (let index = 0; index < target.length; index += 1) {
    target[index] +=
      (cosineCoefficient * phaseCosine + sineCoefficient * phaseSine) * gain;
    const nextCosine =
      phaseCosine * stepCosine - phaseSine * stepSine;
    phaseSine = phaseSine * stepCosine + phaseCosine * stepSine;
    phaseCosine = nextCosine;
  }
}

/**
 * Reconstructs an approximate per-note signal from windowed sinusoidal
 * projections of each detected fundamental and its harmonics. A mono mixture
 * cannot be uniquely separated: partials that coincide within one analysis bin
 * are shared between their possible owners and reported as ambiguous.
 */
export function createNotePhaseLayers(
  input: ArrayLike<number>,
  sampleRate: number,
  inputNotes: readonly PhaseLayerNote[],
  options: NotePhaseLayerOptions = {},
): NotePhaseLayer[] {
  if (
    input.length < 64 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    inputNotes.length === 0
  ) {
    return [];
  }

  const samples = new Float32Array(input.length);
  let mean = 0;
  for (let index = 0; index < input.length; index += 1) {
    samples[index] = finite(input[index]);
    mean += samples[index];
  }
  mean /= samples.length;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] -= mean;
  }
  const inputRms = rms(samples);
  if (inputRms < 1e-6) return [];

  const nyquist = sampleRate / 2;
  const maxFrequency = Math.min(
    nyquist * 0.92,
    Number.isFinite(options.maxFrequency)
      ? Math.max(1, options.maxFrequency as number)
      : 5_000,
  );
  const maxNotes = positiveInteger(options.maxNotes, 6);
  const maxHarmonics = positiveInteger(options.maxHarmonics, 6);
  const maxPoints = positiveInteger(options.maxPoints, 480);
  const minRelativeEnergy = clamp(options.minRelativeEnergy ?? 0.015, 0, 1);

  const uniqueNotes = new Map<number, PhaseLayerNote>();
  for (const note of inputNotes) {
    if (
      !Number.isFinite(note.frequency) ||
      note.frequency <= 0 ||
      note.frequency >= maxFrequency
    ) {
      continue;
    }
    const pitchClass = ((Math.round(note.pitchClass) % 12) + 12) % 12;
    const previous = uniqueNotes.get(pitchClass);
    const score = finite(note.confidence) * Math.max(0.05, finite(note.amplitude));
    const previousScore = previous
      ? finite(previous.confidence) * Math.max(0.05, finite(previous.amplitude))
      : -1;
    if (!previous || score > previousScore) uniqueNotes.set(pitchClass, note);
  }

  const notes = [...uniqueNotes.values()]
    .sort(
      (left, right) =>
        finite(right.confidence) * Math.max(0.05, finite(right.amplitude)) -
        finite(left.confidence) * Math.max(0.05, finite(left.amplitude)),
    )
    .slice(0, maxNotes)
    .sort((left, right) => left.frequency - right.frequency);
  if (notes.length === 0) return [];

  const window = new Float32Array(samples.length);
  let windowSum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value =
      samples.length === 1
        ? 1
        : 0.5 - 0.5 * Math.cos((TWO_PI * index) / (samples.length - 1));
    window[index] = value;
    windowSum += value;
  }

  const candidates: PartialCandidate[] = [];
  notes.forEach((note, noteIndex) => {
    for (let harmonic = 1; harmonic <= maxHarmonics; harmonic += 1) {
      const frequency = note.frequency * harmonic;
      if (frequency > maxFrequency) break;
      candidates.push({ noteIndex, harmonic, frequency });
    }
  });

  const binWidth = sampleRate / samples.length;
  const collisionWidth = binWidth * 1.25;
  const reconstructed = notes.map(() => new Float32Array(samples.length));
  const partialCounts = notes.map(() => 0);
  const ambiguousCounts = notes.map(() => 0);

  for (const candidate of candidates) {
    const owners = new Set(
      candidates
        .filter(
          (other) =>
            Math.abs(other.frequency - candidate.frequency) <= collisionWidth,
        )
        .map((other) => other.noteIndex),
    );
    const projection = projectPartial(
      samples,
      window,
      windowSum,
      sampleRate,
      candidate.frequency,
    );
    if (projection.amplitude < inputRms * 0.035) continue;

    const ownershipGain = 1 / Math.max(1, owners.size);
    addPartial(
      reconstructed[candidate.noteIndex],
      sampleRate,
      candidate.frequency,
      projection.cosine,
      projection.sine,
      ownershipGain,
    );
    partialCounts[candidate.noteIndex] += 1;
    if (owners.size > 1) ambiguousCounts[candidate.noteIndex] += 1;
  }

  return notes.flatMap((note, noteIndex) => {
    const relativeEnergy = clamp(
      rms(reconstructed[noteIndex]) / inputRms,
      0,
      1,
    );
    if (partialCounts[noteIndex] === 0 || relativeEnergy < minRelativeEnergy) {
      return [];
    }
    const confidence = clamp(
      finite(note.confidence) * (0.4 + 0.6 * Math.sqrt(relativeEnergy)),
      0,
      1,
    );
    return [
      {
        pitchClass: ((Math.round(note.pitchClass) % 12) + 12) % 12,
        frequency: note.frequency,
        confidence,
        relativeEnergy,
        partialCount: partialCounts[noteIndex],
        ambiguousPartials: ambiguousCounts[noteIndex],
        points: createPhasePortraitPoints(reconstructed[noteIndex], {
          sampleRate,
          frequencyHz: note.frequency,
          maxPoints,
        }),
      },
    ];
  });
}
