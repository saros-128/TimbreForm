export interface LissajousPoint {
  readonly x: number;
  readonly y: number;
}

export interface LissajousRatio {
  /** Number of horizontal-axis cycles in one closed curve. */
  readonly x: number;
  /** Number of vertical-axis cycles in one closed curve. */
  readonly y: number;
}

export interface PhasePortraitOptions {
  sampleRate: number;
  /** A detected monophonic fundamental. A quarter-period delay is used. */
  frequencyHz?: number | null;
  /** Overrides the frequency-derived delay. */
  delaySamples?: number;
  /** Maximum number of points returned for one frame. */
  maxPoints?: number;
}

interface HarmonicLissajousBaseOptions {
  /** Number of points, including the duplicate point that closes the path. */
  pointCount?: number;
  /** Maximum numerator or denominator used when approximating two frequencies. */
  maxRatioComponent?: number;
  /** Shared parameter phase. This can be advanced continuously between frames. */
  phaseRadians?: number;
  /** Phase of the vertical axis relative to the horizontal axis. */
  relativePhaseRadians?: number;
}

export type HarmonicLissajousOptions = HarmonicLissajousBaseOptions &
  (
    | {
        ratio: readonly [number, number] | LissajousRatio;
        frequenciesHz?: never;
      }
    | {
        frequenciesHz: readonly [number, number];
        ratio?: never;
      }
  );

const TWO_PI = Math.PI * 2;
const DEFAULT_PHASE_PORTRAIT_POINTS = 512;
const DEFAULT_HARMONIC_POINTS = 721;
const DEFAULT_MAX_RATIO_COMPONENT = 16;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.max(1, Math.floor(value as number));
}

function ratioValues(
  ratio: readonly [number, number] | LissajousRatio,
): readonly [number, number] {
  return "x" in ratio ? [ratio.x, ratio.y] : [ratio[0], ratio[1]];
}

/**
 * Returns a delay near 90 degrees for the detected fundamental. Explicit delay
 * wins, so callers may smoothly retain or interpolate a previously known value.
 */
export function resolvePhasePortraitDelay(options: PhasePortraitOptions): number {
  if (Number.isFinite(options.delaySamples) && (options.delaySamples ?? 0) > 0) {
    return Math.max(1, Math.round(options.delaySamples as number));
  }

  if (
    Number.isFinite(options.sampleRate) &&
    options.sampleRate > 0 &&
    Number.isFinite(options.frequencyHz) &&
    (options.frequencyHz ?? 0) > 0
  ) {
    return Math.max(
      1,
      Math.round(options.sampleRate / (4 * (options.frequencyHz as number))),
    );
  }

  if (Number.isFinite(options.sampleRate) && options.sampleRate > 0) {
    // A short delay keeps broadband/unpitched input from collapsing onto the
    // diagonal while remaining useful for voice and guitar fundamentals.
    return Math.max(1, Math.round(options.sampleRate * 0.001));
  }

  return 1;
}

/**
 * Converts a mono waveform to a centered, peak-normalized phase portrait.
 * Coordinates are ordered for direct use with CanvasRenderingContext2D.lineTo.
 */
export function createPhasePortraitPoints(
  samples: ArrayLike<number>,
  options: PhasePortraitOptions,
): LissajousPoint[] {
  if (samples.length < 2) return [];

  let mean = 0;
  for (let index = 0; index < samples.length; index += 1) {
    mean += finiteOrZero(samples[index]);
  }
  mean /= samples.length;

  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    peak = Math.max(peak, Math.abs(finiteOrZero(samples[index]) - mean));
  }
  const scale = peak > Number.EPSILON ? 1 / peak : 0;

  const delay = Math.min(resolvePhasePortraitDelay(options), samples.length - 1);
  const available = samples.length - delay;
  const pointCount = Math.min(
    available,
    positiveInteger(options.maxPoints, DEFAULT_PHASE_PORTRAIT_POINTS),
  );
  const points: LissajousPoint[] = [];

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const offset =
      pointCount === 1
        ? 0
        : Math.round((pointIndex * (available - 1)) / (pointCount - 1));
    const sampleIndex = delay + offset;
    points.push({
      x: (finiteOrZero(samples[sampleIndex]) - mean) * scale,
      y: (finiteOrZero(samples[sampleIndex - delay]) - mean) * scale,
    });
  }

  return points;
}

/**
 * Finds a small integer ratio that best represents two positive values. The
 * logarithmic error treats reciprocal ratios symmetrically.
 */
export function resolveLissajousRatio(
  values: readonly [number, number],
  maxComponent = DEFAULT_MAX_RATIO_COMPONENT,
): LissajousRatio {
  const [xValue, yValue] = values;
  if (
    !Number.isFinite(xValue) ||
    !Number.isFinite(yValue) ||
    xValue <= 0 ||
    yValue <= 0
  ) {
    return { x: 1, y: 1 };
  }

  const maximum = positiveInteger(maxComponent, DEFAULT_MAX_RATIO_COMPONENT);
  const target = xValue / yValue;
  let bestX = 1;
  let bestY = 1;
  let bestError = Number.POSITIVE_INFINITY;
  let bestComplexity = Number.POSITIVE_INFINITY;

  for (let x = 1; x <= maximum; x += 1) {
    for (let y = 1; y <= maximum; y += 1) {
      const error = Math.abs(Math.log(x / y) - Math.log(target));
      const complexity = x + y;
      if (
        error < bestError - Number.EPSILON ||
        (Math.abs(error - bestError) <= Number.EPSILON && complexity < bestComplexity)
      ) {
        bestX = x;
        bestY = y;
        bestError = error;
        bestComplexity = complexity;
      }
    }
  }

  return { x: bestX, y: bestY };
}

/**
 * Generates a deterministic closed curve from either two detected frequencies
 * or a requested frequency ratio. Supplying a continuously changing shared
 * phase preserves the curve while allowing trails or gradients to move.
 */
export function createHarmonicLissajousPoints(
  options: HarmonicLissajousOptions,
): LissajousPoint[] {
  const source =
    "ratio" in options && options.ratio
      ? ratioValues(options.ratio)
      : options.frequenciesHz;
  const ratio = resolveLissajousRatio(
    source,
    options.maxRatioComponent ?? DEFAULT_MAX_RATIO_COMPONENT,
  );
  const pointCount = Math.max(
    2,
    positiveInteger(options.pointCount, DEFAULT_HARMONIC_POINTS),
  );
  const phase = finiteOrZero(options.phaseRadians ?? 0);
  const relativePhase = finiteOrZero(options.relativePhaseRadians ?? Math.PI / 2);
  const points: LissajousPoint[] = [];

  for (let index = 0; index < pointCount - 1; index += 1) {
    const parameter = phase + (TWO_PI * index) / (pointCount - 1);
    points.push({
      x: Math.sin(ratio.x * parameter),
      y: Math.sin(ratio.y * parameter + relativePhase),
    });
  }

  points.push({ ...points[0] });
  return points;
}
