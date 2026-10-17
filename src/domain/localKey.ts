import { mod12 } from "./music";

export type LocalKeyMode = "major" | "minor";

export interface WeightedPitch {
  pitchClass: number;
  weight?: number;
}

export interface PitchObservationGroup {
  pitches: readonly WeightedPitch[];
  weight?: number;
}

export interface PitchClassHistogram {
  bins: readonly number[];
  normalized: readonly number[];
  totalWeight: number;
  observationCount: number;
  pitchCount: number;
  distinctPitchClasses: number;
}

export interface LocalKeyCandidate {
  tonicPitchClass: number;
  mode: LocalKeyMode;
  score: number;
}

export interface TonicEstimate {
  pitchClass: number;
  confidence: number;
  basis: "key-profile" | "single-pitch";
}

export interface LocalKeyEstimate {
  status: "insufficient" | "tentative" | "stable";
  confidence: number;
  candidates: readonly LocalKeyCandidate[];
  tonic: TonicEstimate | null;
  evidenceObservations: number;
  distinctPitchClasses: number;
}

// Krumhansl-Kessler probe-tone profiles. They are small enough for every
// browser-frame analysis and intentionally kept static and deterministic.
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
] as const;

const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
] as const;

const EMPTY_BINS = Object.freeze(Array.from({ length: 12 }, () => 0));

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) {
    throw new TypeError("Pitch weights must be finite");
  }
  return Math.max(0, value);
}

function finishHistogram(
  bins: readonly number[],
  observationCount: number,
  pitchCount: number,
): PitchClassHistogram {
  const totalWeight = bins.reduce((sum, value) => sum + value, 0);
  return {
    bins: [...bins],
    normalized:
      totalWeight > 0
        ? bins.map((value) => value / totalWeight)
        : [...EMPTY_BINS],
    totalWeight,
    observationCount,
    pitchCount,
    distinctPitchClasses: bins.filter((value) => value > 0).length,
  };
}

/** Build a chroma histogram while counting a simultaneous chord as one observation. */
export function buildPitchClassHistogram(
  observations: readonly PitchObservationGroup[],
): PitchClassHistogram {
  const bins = Array.from({ length: 12 }, () => 0);
  let observationCount = 0;
  let pitchCount = 0;

  for (const observation of observations) {
    const observationWeight = finiteNonNegative(observation.weight, 1);
    const strongestByPitchClass = new Map<number, number>();
    for (const pitch of observation.pitches) {
      if (!Number.isFinite(pitch.pitchClass)) {
        throw new TypeError("Pitch classes must be finite");
      }
      const pitchClass = mod12(Math.round(pitch.pitchClass));
      const weight = finiteNonNegative(pitch.weight, 1);
      strongestByPitchClass.set(
        pitchClass,
        Math.max(strongestByPitchClass.get(pitchClass) ?? 0, weight),
      );
    }

    if (strongestByPitchClass.size === 0 || observationWeight === 0) continue;
    observationCount += 1;
    pitchCount += strongestByPitchClass.size;
    for (const [pitchClass, pitchWeight] of strongestByPitchClass) {
      bins[pitchClass] += pitchWeight * observationWeight;
    }
  }

  return finishHistogram(bins, observationCount, pitchCount);
}

/** Merge bar histograms, optionally decaying older bars without losing evidence counts. */
export function mergePitchClassHistograms(
  histograms: readonly PitchClassHistogram[],
  weights: readonly number[] = histograms.map(() => 1),
): PitchClassHistogram {
  if (weights.length !== histograms.length) {
    throw new RangeError("Histogram and weight counts must match");
  }
  const bins = Array.from({ length: 12 }, () => 0);
  let observationCount = 0;
  let pitchCount = 0;
  histograms.forEach((histogram, index) => {
    const weight = finiteNonNegative(weights[index], 1);
    histogram.bins.forEach((value, pitchClass) => {
      bins[pitchClass] += value * weight;
    });
    if (weight > 0) {
      observationCount += histogram.observationCount;
      pitchCount += histogram.pitchCount;
    }
  });
  return finishHistogram(bins, observationCount, pitchCount);
}

function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const centeredA = a[index] - meanA;
    const centeredB = b[index] - meanB;
    numerator += centeredA * centeredB;
    denominatorA += centeredA * centeredA;
    denominatorB += centeredB * centeredB;
  }
  if (denominatorA === 0 || denominatorB === 0) return 0;
  return numerator / Math.sqrt(denominatorA * denominatorB);
}

function rotatedProfile(profile: readonly number[], tonic: number): number[] {
  return Array.from({ length: 12 }, (_, pitchClass) =>
    profile[mod12(pitchClass - tonic)],
  );
}

/** Rank all 24 major/minor keys and expose evidence-limited confidence separately. */
export function estimateLocalKey(
  histogram: PitchClassHistogram,
  candidateLimit = 5,
): LocalKeyEstimate {
  if (histogram.totalWeight <= 0 || histogram.distinctPitchClasses === 0) {
    return {
      status: "insufficient",
      confidence: 0,
      candidates: [],
      tonic: null,
      evidenceObservations: histogram.observationCount,
      distinctPitchClasses: histogram.distinctPitchClasses,
    };
  }

  if (histogram.distinctPitchClasses === 1) {
    const pitchClass = histogram.bins.findIndex((value) => value > 0);
    return {
      status: "insufficient",
      confidence: 0.08,
      candidates: [],
      tonic: { pitchClass, confidence: 0.08, basis: "single-pitch" },
      evidenceObservations: histogram.observationCount,
      distinctPitchClasses: 1,
    };
  }

  const allCandidates: LocalKeyCandidate[] = [];
  for (let tonicPitchClass = 0; tonicPitchClass < 12; tonicPitchClass += 1) {
    for (const [mode, profile] of [
      ["major", MAJOR_PROFILE],
      ["minor", MINOR_PROFILE],
    ] as const) {
      const correlation = pearsonCorrelation(
        histogram.normalized,
        rotatedProfile(profile, tonicPitchClass),
      );
      const profileFit = clamp01((correlation + 1) / 2);
      const tonicShare = histogram.normalized[tonicPitchClass];
      allCandidates.push({
        tonicPitchClass,
        mode,
        score: clamp01(profileFit * 0.9 + tonicShare * 0.1),
      });
    }
  }

  allCandidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.tonicPitchClass - b.tonicPitchClass ||
      a.mode.localeCompare(b.mode),
  );

  const top = allCandidates[0];
  const runnerUp = allCandidates[1];
  const evidence = clamp01((histogram.observationCount - 1) / 7);
  const pitchDiversity = clamp01((histogram.distinctPitchClasses - 1) / 4);
  const fit = clamp01((top.score - 0.5) / 0.42);
  const separation = clamp01((top.score - runnerUp.score) / 0.12);
  const confidence = clamp01(
    evidence * pitchDiversity * fit * (0.4 + separation * 0.6),
  );
  const status =
    histogram.observationCount < 3 || histogram.distinctPitchClasses < 3
      ? "insufficient"
      : confidence >= 0.55
        ? "stable"
        : "tentative";

  return {
    status,
    confidence,
    candidates: allCandidates.slice(0, Math.max(1, Math.floor(candidateLimit))),
    tonic: {
      pitchClass: top.tonicPitchClass,
      confidence: status === "insufficient" ? Math.min(confidence, 0.15) : confidence,
      basis: "key-profile",
    },
    evidenceObservations: histogram.observationCount,
    distinctPitchClasses: histogram.distinctPitchClasses,
  };
}
