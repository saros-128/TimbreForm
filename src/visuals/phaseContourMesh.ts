/** Indices address the existing rendered phase path, never synthesized vertices. */
export interface PhaseContourMesh {
  periodSamples: number | null;
  confidence: number;
  bridges: Array<[number, number]>;
  quads: Array<[number, number, number, number]>;
}

export interface PhaseContourMeshInput {
  /** Coordinates before camera projection or the visual depth deformation. */
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Original sample addressed by each rendered path point, in increasing order. */
  sampleIndices?: readonly number[];
  maxBridges?: number;
  maxFaces?: number;
}

const EMPTY: PhaseContourMesh = {
  periodSamples: null,
  confidence: 0,
  bridges: [],
  quads: [],
};

function interpolate(data: ArrayLike<number>, position: number): number {
  const lower = Math.max(0, Math.min(data.length - 1, Math.floor(position)));
  const upper = Math.min(data.length - 1, lower + 1);
  return data[lower] + (data[upper] - data[lower]) * (position - lower);
}

/** Joint recurrence prevents matching unrelated branches of a crossing curve. */
function recurrence(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  length: number,
) {
  const count = Math.min(length, 512);
  const scale = (length - 1) / (count - 1);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < count; index += 1) {
    xs[index] = interpolate(x, index * scale);
    ys[index] = interpolate(y, index * scale);
    if (!Number.isFinite(xs[index]) || !Number.isFinite(ys[index])) return null;
    meanX += xs[index] / count;
    meanY += ys[index] / count;
  }
  let energy = 0;
  let energyX = 0;
  let energyY = 0;
  for (let index = 0; index < count; index += 1) {
    xs[index] -= meanX;
    ys[index] -= meanY;
    energyX += xs[index] ** 2;
    energyY += ys[index] ** 2;
    energy += xs[index] ** 2 + ys[index] ** 2;
  }
  if (energy / count < 1e-10) return null;

  // Require more than two turns; a single curved stroke is not evidence of a mesh.
  const maxLag = Math.floor((count - 1) / 2.2);
  const errors = new Float64Array(maxLag + 2);
  const xErrors = new Float64Array(maxLag + 2);
  const yErrors = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag += 1) {
    let differenceX = 0;
    let differenceY = 0;
    let reference = 0;
    const stride = Math.max(1, Math.floor((count - lag) / 128));
    for (let index = 0; index + lag < count; index += stride) {
      const next = index + lag;
      differenceX += (xs[index] - xs[next]) ** 2;
      differenceY += (ys[index] - ys[next]) ** 2;
      reference +=
        xs[index] ** 2 + ys[index] ** 2 + xs[next] ** 2 + ys[next] ** 2;
    }
    errors[lag] = (differenceX + differenceY) / Math.max(reference, 1e-12);
    xErrors[lag] = differenceX / Math.max(1, Math.ceil((count - lag) / stride));
    yErrors[lag] = differenceY / Math.max(1, Math.ceil((count - lag) / stride));
  }
  const minima: number[] = [];
  for (let lag = 2; lag <= maxLag; lag += 1) {
    if (errors[lag] <= errors[lag - 1] && errors[lag] < errors[lag + 1]) {
      minima.push(lag);
    }
  }
  if (!minima.length) return null;
  const best = Math.min(...minima.map((lag) => errors[lag]));
  // Prefer the first good recurrence over its integer multiples. Broad noise or
  // an accidental self-intersection does not meet this whole-window condition.
  const coordinateReturns = (
    axisErrors: Float64Array,
    axisEnergy: number,
    candidate: number,
  ) => {
    if (axisEnergy < energy * 0.02) return true;
    let excursion = 0;
    for (let index = 1; index < candidate; index += 1)
      excursion = Math.max(excursion, axisErrors[index]);
    return axisErrors[candidate] < excursion * 0.45;
  };
  const lag = minima.find(
    (candidate) =>
      errors[candidate] <= Math.min(0.2, best * 1.8 + 0.035) &&
      coordinateReturns(xErrors, energyX, candidate) &&
      coordinateReturns(yErrors, energyY, candidate),
  );
  if (lag === undefined || lag < 6) return null;
  const curvature = errors[lag - 1] - 2 * errors[lag] + errors[lag + 1];
  const offset =
    curvature > 1e-10
      ? Math.max(
          -0.5,
          Math.min(0.5, (errors[lag - 1] - errors[lag + 1]) / (2 * curvature)),
        )
      : 0;
  return {
    period: (lag + offset) * scale,
    confidence: Math.max(0, 1 - errors[lag]),
  };
}

/** Repeated x/y extrema and sharp bends; a smooth round contour uses four ribs. */
function contourLandmarks(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  period: number,
) {
  const count = 64;
  const xs = Array.from({ length: count }, (_, index) =>
    interpolate(x, (period * index) / count),
  );
  const ys = Array.from({ length: count }, (_, index) =>
    interpolate(y, (period * index) / count),
  );
  const turn = xs.map((_, index) => {
    const previous = (index + count - 1) % count;
    const next = (index + 1) % count;
    const ax = xs[index] - xs[previous];
    const ay = ys[index] - ys[previous];
    const bx = xs[next] - xs[index];
    const by = ys[next] - ys[index];
    const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return denominator > 1e-12 ? 1 - (ax * bx + ay * by) / denominator : 0;
  });
  const meanTurn = turn.reduce((sum, value) => sum + value, 0) / count;
  const candidates: Array<{ phase: number; score: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const previous = (index + count - 1) % count;
    const next = (index + 1) % count;
    const extremum = (values: number[]) =>
      (values[index] > values[previous] && values[index] >= values[next]) ||
      (values[index] < values[previous] && values[index] <= values[next]);
    const isCorner =
      turn[index] > meanTurn * 1.5 &&
      turn[index] >= turn[previous] &&
      turn[index] >= turn[next];
    if (extremum(xs) || extremum(ys) || isCorner) {
      candidates.push({
        phase: index / count,
        score: turn[index] / Math.max(meanTurn, 1e-9) + (isCorner ? 2 : 0),
      });
    }
  }
  candidates.sort(
    (left, right) => right.score - left.score || left.phase - right.phase,
  );
  const chosen: number[] = [];
  for (const candidate of candidates) {
    if (
      chosen.every(
        (phase) =>
          Math.min(
            Math.abs(candidate.phase - phase),
            1 - Math.abs(candidate.phase - phase),
          ) >=
          1 / 12,
      )
    ) {
      chosen.push(candidate.phase);
      if (chosen.length === 8) break;
    }
  }
  if (chosen.length < 3) return [0, 0.25, 0.5, 0.75];
  return chosen.sort((left, right) => left - right);
}

function nearestIndex(indices: readonly number[], source: number): number {
  let lower = 0;
  let upper = indices.length - 1;
  while (upper - lower > 1) {
    const middle = (lower + upper) >>> 1;
    if (indices[middle] < source) lower = middle;
    else upper = middle;
  }
  return Math.abs(indices[lower] - source) <= Math.abs(indices[upper] - source)
    ? lower
    : upper;
}

/**
 * Connects corresponding positions one period apart within ONE captured trace.
 * It does not join layers, frames, or the two ends of the analysis window.
 * Analysis is bounded to 512 samples; output defaults to 96 ribs / 600 faces.
 */
export function buildPhaseContourMesh(
  input: PhaseContourMeshInput,
): PhaseContourMesh {
  const length = Math.min(input.x.length, input.y.length);
  if (length < 24) return { ...EMPTY, bridges: [], quads: [] };
  const indices =
    input.sampleIndices ?? Array.from({ length }, (_, index) => index);
  if (indices.length < 12) return { ...EMPTY, bridges: [], quads: [] };
  if (
    indices.some(
      (value, index) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value >= length ||
        (index > 0 && value <= indices[index - 1]),
    )
  ) {
    return { ...EMPTY, bridges: [], quads: [] };
  }
  const found = recurrence(input.x, input.y, length);
  if (!found) return { ...EMPTY, bridges: [], quads: [] };
  const { period, confidence } = found;
  const mesh: PhaseContourMesh = {
    periodSamples: period,
    confidence,
    bridges: [],
    quads: [],
  };
  const limit = (value: number | undefined, fallback: number) =>
    Number.isFinite(value)
      ? Math.max(0, Math.min(fallback, Math.floor(value!)))
      : fallback;
  const maxBridges = limit(input.maxBridges, 96);
  const maxFaces = limit(input.maxFaces, 600);
  const start = indices[0];
  const end = indices[indices.length - 1] - period;
  if (end <= start || (period * indices.length) / length < 4) return mesh;

  const mappedPair = (source: number): [number, number] | null => {
    const left = nearestIndex(indices, source);
    const right = nearestIndex(indices, source + period);
    // Rendering may omit samples at low detail. Do not bridge a different phase
    // merely because it is the nearest point still present in the drawn path.
    const tolerance = period * 0.085;
    if (
      right <= left ||
      Math.abs(indices[left] - source) > tolerance ||
      Math.abs(indices[right] - source - period) > tolerance
    )
      return null;
    return [left, right];
  };

  if (maxBridges > 0) {
    const landmarks = contourLandmarks(input.x, input.y, period);
    const turns = Math.ceil(length / period);
    const turnStride = Math.max(
      1,
      Math.ceil((turns * landmarks.length) / maxBridges),
    );
    const seen = new Set<string>();
    for (
      let turn = 0;
      turn < turns && mesh.bridges.length < maxBridges;
      turn += turnStride
    ) {
      for (const phase of landmarks) {
        const source = (turn + phase) * period;
        if (source < start || source > end) continue;
        const pair = mappedPair(source);
        if (!pair) continue;
        const key = pair.join(":");
        if (!seen.has(key)) {
          seen.add(key);
          mesh.bridges.push(pair);
        }
      }
    }
  }

  if (maxFaces > 0) {
    const step = Math.max(
      1,
      Math.min(period / 8, Math.max(period / 64, (end - start) / maxFaces)),
    );
    const segments = Math.ceil((end - start) / step);
    const stride = Math.max(1, Math.ceil(segments / maxFaces));
    // At a small face budget omit panels, rather than spanning unrelated phases
    // with giant faces. Every retained panel still joins adjacent contour arcs.
    for (
      let segment = 0;
      segment < segments && mesh.quads.length < maxFaces;
      segment += stride
    ) {
      const source = start + segment * step;
      const previous = mappedPair(source);
      const current = mappedPair(Math.min(source + step, end));
      if (
        previous &&
        current &&
        previous[0] < current[0] &&
        current[0] < previous[1] &&
        previous[1] < current[1]
      ) {
        mesh.quads.push([previous[0], current[0], current[1], previous[1]]);
      }
    }
  }
  return mesh;
}
