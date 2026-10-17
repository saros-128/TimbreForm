export interface FractalControlNote {
  pitchClass: number;
  frequency: number;
  confidence: number;
  amplitude: number;
}

export interface FractalFlightParameters {
  /** First continuous tonal geometry control. */
  cX: number;
  /** Second continuous tonal geometry control. */
  cY: number;
  /** Base colour angle in degrees in the half-open range [0, 360). */
  hue: number;
  /** Geometry modulation strength in the range [0.06, 0.95]. */
  warp: number;
  /** Forward animation multiplier in the range [0.08, 1.15]. */
  speed: number;
  /** Normalized signal energy in the range [0, 1]. */
  energy: number;
  /** Number of distinct pitch classes used by the model, capped at eight. */
  noteCount: number;
  /** Tonal structure control in [0, 1], used for camera and colour variation. */
  family: number;
  /** Signed camera travel control in the range [-1, 1]. */
  zoomDirection: number;
}

export interface GatePose {
  /** Positive distance from the camera, in world units. */
  depth: number;
  offsetX: number;
  offsetY: number;
  /** Euler rotations in radians. */
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
}

export interface ProjectedGatePoint {
  x: number;
  y: number;
  /** False when the point is invalid or on/behind the near camera plane. */
  visible: boolean;
}

interface NormalizedNote {
  pitchClass: number;
  frequency: number;
  confidence: number;
  amplitude: number;
  weight: number;
}

const TWO_PI = Math.PI * 2;
const MAX_CONTROL_NOTES = 8;
const NEAR_PLANE = 0.05;
const FOCAL_LENGTH_FACTOR = 0.9;

export const FLIGHT_GATE_CAPACITY = 16;
export const FLIGHT_GATE_START_DEPTH = 6;
export const FLIGHT_GATE_EXIT_DEPTH = -0.9;
export const FLIGHT_GATE_MIN_DEPTH_GAP = 2;
export const FLIGHT_GATE_MIN_SPAWN_INTERVAL_MS = 1_350;
/** Gates follow their matching live note at full speed beyond this plane. */
export const FLIGHT_GATE_FULL_LIVE_DEPTH = 4.2;
/** Large gates keep a filtered live response instead of becoming cardboard. */
export const FLIGHT_GATE_NEAR_MORPH_FLOOR = 0.26;
/** Past this plane a portrait becomes a self-animating echo of its live shape. */
export const FLIGHT_GATE_COAST_DEPTH = 2.2;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Admits a new gate only while capacity is available. Existing gates are kept
 * so an approaching portrait can always complete its pass through the camera.
 */
export function admitFlightGate<T>(
  gates: readonly T[],
  gate: T,
  capacity = FLIGHT_GATE_CAPACITY,
): readonly T[] {
  const limit = Number.isFinite(capacity)
    ? Math.max(0, Math.floor(capacity))
    : FLIGHT_GATE_CAPACITY;
  return gates.length >= limit ? gates : [...gates, gate];
}

/**
 * Keeps the launch plane clear so consecutive portraits read as a tunnel,
 * rather than several nearly identical traces occupying the same depth.
 */
export function canLaunchFlightGate(
  gates: readonly { depth: number }[],
  elapsedSinceSpawnMs: number,
): boolean {
  const elapsed =
    elapsedSinceSpawnMs === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, finiteOr(elapsedSinceSpawnMs, 0));
  if (elapsed < FLIGHT_GATE_MIN_SPAWN_INTERVAL_MS) return false;

  const launchBoundary = FLIGHT_GATE_START_DEPTH - FLIGHT_GATE_MIN_DEPTH_GAP;
  return gates.every(
    (gate) => !Number.isFinite(gate.depth) || gate.depth <= launchBoundary,
  );
}

export function advanceFlightGateDepth(
  depth: number,
  deltaSeconds: number,
  speedControl: number,
): number {
  if (!Number.isFinite(depth)) return FLIGHT_GATE_EXIT_DEPTH;
  const elapsed = clamp(finiteOr(deltaSeconds, 0), 0, 0.1);
  const speed = clamp(finiteOr(speedControl, 0), 0, 1.15);
  return depth - elapsed * (0.78 + speed * 0.58);
}

/** Keeps a gate crisp through the near plane, then fades it behind the camera. */
export function flightGateOpacity(depth: number): number {
  if (!Number.isFinite(depth)) return 0;
  const farFade = clamp((7.2 - depth) / 3.2, 0.12, 1);
  const nearFade =
    depth >= 0
      ? 1
      : clamp(
          (depth - FLIGHT_GATE_EXIT_DEPTH) /
            -FLIGHT_GATE_EXIT_DEPTH,
          0,
          1,
        );
  return farFade * nearFade;
}

/**
 * Depth-dependent live geometry. A distant portrait follows quickly and a
 * near portrait follows slowly, but it never freezes while its source exists.
 */
export function flightGateMorphStrength(depth: number): number {
  if (!Number.isFinite(depth)) return 0;
  if (depth >= FLIGHT_GATE_FULL_LIVE_DEPTH) return 1;
  if (depth <= 0) return FLIGHT_GATE_NEAR_MORPH_FLOOR;
  const progress = clamp(depth / FLIGHT_GATE_FULL_LIVE_DEPTH, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  return FLIGHT_GATE_NEAR_MORPH_FLOOR +
    (1 - FLIGHT_GATE_NEAR_MORPH_FLOOR) * eased;
}

/** Frame-rate-independent smoothing for the depth-filtered live geometry. */
export function flightGateMorphAlpha(
  depth: number,
  deltaSeconds: number,
): number {
  const strength = flightGateMorphStrength(depth);
  if (strength <= 0) return 0;
  const elapsed = clamp(finiteOr(deltaSeconds, 0), 0, 0.05);
  if (elapsed <= 0) return 0;
  const timeConstant = 0.14 + (1 - strength) * 0.24;
  return 1 - Math.exp((-elapsed * strength) / timeConstant);
}

/**
 * Smoothly enters an autonomous echo after a pitch disappears and leaves it
 * when the matching live layer returns. The echo drives subtle draw-time
 * deformation without rewriting the captured portrait.
 */
export function advanceFlightGateEcho(
  current: number,
  sourcePresent: boolean,
  deltaSeconds: number,
): number {
  const value = clamp(finiteOr(current, 0), 0, 1);
  const target = sourcePresent ? 0 : 1;
  const elapsed = clamp(finiteOr(deltaSeconds, 0), 0, 0.05);
  if (elapsed <= 0 || value === target) return value;
  const timeConstant = sourcePresent ? 0.2 : 0.38;
  const alpha = 1 - Math.exp(-elapsed / timeConstant);
  return value + (target - value) * alpha;
}

/** Frame-rate-independent smoothing for an autonomous phase echo. */
export function flightGateCoastAlpha(deltaSeconds: number): number {
  const elapsed = clamp(finiteOr(deltaSeconds, 0), 0, 0.05);
  if (elapsed <= 0) return 0;
  return 1 - Math.exp(-elapsed / 0.11);
}

/**
 * Writes a gently breathing closed contour into an existing gate buffer.
 * The deformation is derived from the captured contour normal, so an echo
 * stays recognisable while continuing to move after its audio source ends.
 */
export function writeFlightGateEchoTarget(
  anchor: ArrayLike<number>,
  target: Float32Array,
  pitchClass: number,
  gateId: number,
  phase: number,
  depth: number,
  ageSeconds: number,
): void {
  const pointCount = Math.min(
    Math.floor(anchor.length / 2),
    Math.floor(target.length / 2),
  );
  if (pointCount < 2) return;

  const normalizedPitch = modulo(Math.round(finiteOr(pitchClass, 0)), 12);
  const normalizedGateId = Math.abs(Math.round(finiteOr(gateId, 0)));
  const safePhase = finiteOr(phase, 0);
  const age = Math.max(0, finiteOr(ageSeconds, 0));
  const ageProgress = clamp(age / 0.38, 0, 1);
  const ageRamp = ageProgress * ageProgress * (3 - 2 * ageProgress);
  const depthScale = clamp((finiteOr(depth, 0) + 0.9) / 4.8, 0.22, 1);
  const amplitude = 0.075 * depthScale * ageRamp;
  const breath =
    1 +
    ageRamp *
      (0.014 * Math.sin(safePhase * 0.71 + normalizedPitch * 0.37) +
        0.008 * Math.sin(safePhase * 1.31 - normalizedGateId * 0.19));

  for (let index = 0; index < pointCount; index += 1) {
    const previous = circularIndex(index - 1, pointCount);
    const next = circularIndex(index + 1, pointCount);
    const x = pathValue(anchor, index * 2);
    const y = pathValue(anchor, index * 2 + 1);
    const tangentX =
      pathValue(anchor, next * 2) - pathValue(anchor, previous * 2);
    const tangentY =
      pathValue(anchor, next * 2 + 1) -
      pathValue(anchor, previous * 2 + 1);
    const tangentLength = Math.hypot(tangentX, tangentY);
    const radialLength = Math.hypot(x, y);
    const normalX =
      tangentLength > 1e-6
        ? -tangentY / tangentLength
        : radialLength > 1e-6
          ? x / radialLength
          : 1;
    const normalY =
      tangentLength > 1e-6
        ? tangentX / tangentLength
        : radialLength > 1e-6
          ? y / radialLength
          : 0;
    const theta = (index / pointCount) * TWO_PI;
    const wave =
      Math.sin(theta * (2 + (normalizedPitch % 4)) + safePhase) +
      0.45 *
        Math.sin(
          theta * (5 + ((normalizedPitch + normalizedGateId) % 4)) -
            safePhase * 0.63,
        );
    const displacement = amplitude * wave;

    target[index * 2] = x * breath + normalX * displacement;
    target[index * 2 + 1] = y * breath + normalY * displacement;
  }
}

/** Crossfades the next portrait while the front one passes through camera. */
export function flightGateHandoffProgress(frontDepth: number): number {
  if (!Number.isFinite(frontDepth)) return 1;
  const progress = clamp((1.65 - frontDepth) / 1.2, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

/**
 * Staggers the fade-out and fade-in around the handoff midpoint. The two
 * portraits are never visible together, so their line fields cannot tangle.
 */
export function flightGateHandoffWeights(frontDepth: number): {
  front: number;
  successor: number;
} {
  const progress = flightGateHandoffProgress(frontDepth);
  const frontProgress = clamp(progress * 2, 0, 1);
  const successorProgress = clamp((progress - 0.5) * 2, 0, 1);
  const smooth = (value: number) => value * value * (3 - 2 * value);
  return {
    front: 1 - smooth(frontProgress),
    successor: smooth(successorProgress),
  };
}

/** Matches the shader's guaranteed boundary focus for diagnostics and tests. */
export function repellingJuliaFixedPoint(
  cX: number,
  cY: number,
): { x: number; y: number } {
  const real = 1 - 4 * finiteOr(cX, 0);
  const imaginary = -4 * finiteOr(cY, 0);
  const radius = Math.hypot(real, imaginary);
  const squareRootX = Math.sqrt(Math.max(0, (radius + real) / 2));
  const squareRootY =
    (imaginary < 0 ? -1 : 1) *
    Math.sqrt(Math.max(0, (radius - real) / 2));
  const first = { x: (1 + squareRootX) / 2, y: squareRootY / 2 };
  const second = { x: (1 - squareRootX) / 2, y: -squareRootY / 2 };
  return first.x * first.x + first.y * first.y >=
    second.x * second.x + second.y * second.y
    ? first
    : second;
}

function pathValue(points: ArrayLike<number>, index: number): number {
  const value = points[index];
  return Number.isFinite(value) ? value : 0;
}

function circularIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

/**
 * Finds the cyclic source offset that best matches the currently displayed
 * closed portrait. This removes apparent twisting caused only by an audio
 * window beginning at a different waveform phase.
 */
export function findCyclicTraceOffset(
  reference: ArrayLike<number>,
  source: ArrayLike<number>,
  previousOffset?: number,
): number {
  const referenceCount = Math.floor(reference.length / 2);
  const sourceCount = Math.floor(source.length / 2);
  if (referenceCount < 2 || sourceCount < 2) return 0;

  const probeCount = Math.min(32, referenceCount);
  const candidateCount = Math.min(32, sourceCount);
  const hasPrevious = Number.isFinite(previousOffset);
  const normalizedPrevious = hasPrevious
    ? circularIndex(Math.round(previousOffset ?? 0), sourceCount)
    : 0;

  const costForOffset = (offset: number): number => {
    const normalizedOffset = circularIndex(offset, sourceCount);
    let cost = 0;
    for (let probe = 0; probe < probeCount; probe += 1) {
      const referenceIndex = Math.floor((probe * referenceCount) / probeCount);
      const sourceIndex = circularIndex(
        Math.floor((referenceIndex * sourceCount) / referenceCount) +
          normalizedOffset,
        sourceCount,
      );
      const deltaX =
        pathValue(reference, referenceIndex * 2) -
        pathValue(source, sourceIndex * 2);
      const deltaY =
        pathValue(reference, referenceIndex * 2 + 1) -
        pathValue(source, sourceIndex * 2 + 1);
      cost += deltaX * deltaX + deltaY * deltaY;
    }
    cost /= probeCount;

    if (hasPrevious) {
      const directDistance = Math.abs(normalizedOffset - normalizedPrevious);
      const circularDistance = Math.min(
        directDistance,
        sourceCount - directDistance,
      );
      const normalizedDistance = circularDistance / sourceCount;
      cost += normalizedDistance * normalizedDistance * 0.006;
    }
    return cost;
  };

  let bestOffset = normalizedPrevious;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    const offset = Math.floor((candidate * sourceCount) / candidateCount);
    const cost = costForOffset(offset);
    if (cost < bestCost) {
      bestCost = cost;
      bestOffset = offset;
    }
  }

  const refinementRadius = Math.max(
    1,
    Math.ceil(sourceCount / candidateCount),
  );
  const coarseOffset = bestOffset;
  for (let delta = -refinementRadius; delta <= refinementRadius; delta += 1) {
    const offset = circularIndex(coarseOffset + delta, sourceCount);
    const cost = costForOffset(offset);
    if (cost < bestCost) {
      bestCost = cost;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

/**
 * Resamples a cyclic source directly into a gate-owned fixed-size buffer.
 * Optional anchor clamping keeps the onset identity recognizable while alive.
 */
export function resampleCyclicTraceInto(
  target: Float32Array,
  source: ArrayLike<number>,
  phaseOffset = 0,
  anchor?: ArrayLike<number>,
  maximumAnchorDelta = Number.POSITIVE_INFINITY,
): void {
  const targetCount = Math.floor(target.length / 2);
  const sourceCount = Math.floor(source.length / 2);
  if (targetCount < 1 || sourceCount < 1) return;
  const normalizedOffset = circularIndex(Math.round(phaseOffset), sourceCount);
  const anchorLimit = Math.max(0, finiteOr(maximumAnchorDelta, Number.POSITIVE_INFINITY));
  const hasAnchor = Boolean(anchor && anchor.length >= targetCount * 2);

  for (let index = 0; index < targetCount; index += 1) {
    const sourcePosition =
      (index * sourceCount) / targetCount + normalizedOffset;
    const sourceFloor = Math.floor(sourcePosition);
    const first = circularIndex(sourceFloor, sourceCount);
    const second = circularIndex(first + 1, sourceCount);
    const fraction = sourcePosition - sourceFloor;
    const firstX = pathValue(source, first * 2);
    const firstY = pathValue(source, first * 2 + 1);
    let nextX = firstX + (pathValue(source, second * 2) - firstX) * fraction;
    let nextY = firstY + (pathValue(source, second * 2 + 1) - firstY) * fraction;

    if (hasAnchor && Number.isFinite(anchorLimit)) {
      const anchorX = pathValue(anchor as ArrayLike<number>, index * 2);
      const anchorY = pathValue(anchor as ArrayLike<number>, index * 2 + 1);
      nextX = clamp(nextX, anchorX - anchorLimit, anchorX + anchorLimit);
      nextY = clamp(nextY, anchorY - anchorLimit, anchorY + anchorLimit);
    }
    target[index * 2] = nextX;
    target[index * 2 + 1] = nextY;
  }
}

/** Mutates only the gate's display buffer and allocates nothing. */
export function morphTracePointsInPlace(
  current: Float32Array,
  target: ArrayLike<number>,
  amount: number,
): boolean {
  const count = Math.min(current.length, target.length);
  const interpolation = clamp(finiteOr(amount, 0), 0, 1);
  if (count === 0 || interpolation <= 0) return false;
  let changed = false;
  for (let index = 0; index < count; index += 1) {
    const before = pathValue(current, index);
    const after = before + (pathValue(target, index) - before) * interpolation;
    current[index] = after;
    if (Math.abs(after - before) > 1e-7) changed = true;
  }
  return changed;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function normalizedControlNotes(
  notes: readonly FractalControlNote[],
): NormalizedNote[] {
  const strongestByPitchClass = new Map<number, NormalizedNote>();

  for (const note of notes) {
    if (
      !Number.isFinite(note.pitchClass) ||
      !Number.isFinite(note.frequency) ||
      note.frequency <= 0
    ) {
      continue;
    }

    const confidence = clamp(finiteOr(note.confidence, 0), 0, 1);
    const amplitude = clamp(finiteOr(note.amplitude, 0), 0, 1);
    if (confidence <= 0 || amplitude <= 0) continue;

    const pitchClass = modulo(Math.round(note.pitchClass), 12);
    const weight = confidence * (0.2 + 0.8 * Math.sqrt(amplitude));
    const normalized = {
      pitchClass,
      frequency: note.frequency,
      confidence,
      amplitude,
      weight,
    };
    const previous = strongestByPitchClass.get(pitchClass);

    if (
      !previous ||
      normalized.weight > previous.weight ||
      (normalized.weight === previous.weight &&
        (normalized.confidence > previous.confidence ||
          (normalized.confidence === previous.confidence &&
            (normalized.amplitude > previous.amplitude ||
              (normalized.amplitude === previous.amplitude &&
                normalized.frequency < previous.frequency)))))
    ) {
      strongestByPitchClass.set(pitchClass, normalized);
    }
  }

  return [...strongestByPitchClass.values()]
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.pitchClass - right.pitchClass ||
        left.frequency - right.frequency,
    )
    .slice(0, MAX_CONTROL_NOTES)
    .sort(
      (left, right) =>
        left.pitchClass - right.pitchClass || left.frequency - right.frequency,
    );
}

/**
 * Reduces the current note frame to stable, bounded controls for the continuous
 * fractal-flight renderer. Duplicate octaves share one pitch-class control so
 * octave doubling does not cause a discontinuous jump in visual complexity.
 */
export function deriveFractalFlightParameters(
  notes: readonly FractalControlNote[],
  rms: number,
): FractalFlightParameters {
  const controls = normalizedControlNotes(notes);
  const noteCount = controls.length;
  const rmsEnergy = Math.sqrt(clamp(finiteOr(rms, 0), 0, 1));

  let weightSum = 0;
  let pitchX = 0;
  let pitchY = 0;
  let weightedAmplitude = 0;
  let weightedRegister = 0;
  let weightedPitchClass = 0;

  for (const note of controls) {
    const angle = (note.pitchClass / 12) * TWO_PI;
    const register = clamp(Math.log2(note.frequency / 55) / 6, 0, 1);
    weightSum += note.weight;
    pitchX += Math.cos(angle) * note.weight;
    pitchY += Math.sin(angle) * note.weight;
    weightedAmplitude += note.amplitude * note.weight;
    weightedRegister += register * note.weight;
    weightedPitchClass += note.pitchClass * note.weight;
  }

  if (weightSum > 0) {
    pitchX /= weightSum;
    pitchY /= weightSum;
    weightedAmplitude /= weightSum;
    weightedRegister /= weightSum;
    weightedPitchClass /= weightSum;
  } else {
    weightedRegister = 0.5;
  }

  const pitchMagnitude = clamp(Math.hypot(pitchX, pitchY), 0, 1);
  const pitchSpread = noteCount > 0 ? 1 - pitchMagnitude : 0;
  const chordComplexity = Math.max(0, noteCount - 1) / (MAX_CONTROL_NOTES - 1);
  const energy = clamp(
    rmsEnergy * 0.78 + weightedAmplitude * 0.22,
    0,
    1,
  );

  let pitchHue = 210;
  if (noteCount > 0) {
    pitchHue =
      pitchMagnitude > 1e-8
        ? (Math.atan2(pitchY, pitchX) * 180) / Math.PI
        : weightedPitchClass * 30;
    pitchHue += (weightedRegister - 0.5) * 18;
  }

  const family =
    noteCount > 0
      ? clamp(
          0.5 - pitchX * 0.18 + pitchY * 0.38 +
            pitchSpread * 0.25 + chordComplexity * 0.18,
          0,
          1,
        )
      : 0.28;
  const directionSeed =
    pitchX * 0.72 + pitchY * 0.48 + (weightedRegister - 0.5) * 0.8;
  const directionSign =
    Math.abs(directionSeed) >= 0.08
      ? Math.sign(directionSeed)
      : family >= 0.5
        ? 1
        : -1;
  const zoomDirection =
    noteCount > 0
      ? directionSign * clamp(
          0.38 + energy * 0.46 + chordComplexity * 0.12,
          0.38,
          0.96,
        )
      : 0.14;

  const tonalAngle =
    noteCount > 0
      ? pitchMagnitude > 0.14
        ? Math.atan2(pitchY, pitchX)
        : (weightedPitchClass / 12) * TWO_PI
      : 0;
  const structuralAngle =
    tonalAngle + pitchSpread * 0.42 + chordComplexity * 0.68;
  const multiplierRadius = clamp(
    0.945 + energy * 0.025 + chordComplexity * 0.018,
    0.94,
    0.992,
  );
  const multiplierX = Math.cos(structuralAngle) * multiplierRadius;
  const multiplierY = Math.sin(structuralAngle) * multiplierRadius;
  const canonicalCX =
    multiplierX * 0.5 -
    (multiplierX * multiplierX - multiplierY * multiplierY) * 0.25;
  const canonicalCY =
    multiplierY * 0.5 - multiplierX * multiplierY * 0.5;

  return {
    cX: noteCount > 0 ? canonicalCX : -0.74543,
    cY: noteCount > 0 ? canonicalCY : 0.11301,
    hue: modulo(pitchHue, 360),
    warp: clamp(
      0.08 + pitchSpread * 0.48 + chordComplexity * 0.16 + energy * 0.23,
      0.06,
      0.95,
    ),
    speed: clamp(
      0.08 + energy * 0.72 + chordComplexity * 0.12 + weightedRegister * 0.1,
      0.08,
      1.15,
    ),
    energy,
    noteCount,
    family,
    zoomDirection,
  };
}

function hiddenPoint(width: number, height: number): ProjectedGatePoint {
  return {
    x: Number.isFinite(width) && width > 0 ? width / 2 : 0,
    y: Number.isFinite(height) && height > 0 ? height / 2 : 0,
    visible: false,
  };
}

/**
 * Projects a point from a gate's local XY plane into screen pixels. Rotation is
 * applied roll (Z), pitch (X), then yaw (Y); positive local Y points upward.
 */
export function projectGatePoint(
  x: number,
  y: number,
  pose: GatePose,
  width: number,
  height: number,
): ProjectedGatePoint {
  const values = [
    x,
    y,
    pose.depth,
    pose.offsetX,
    pose.offsetY,
    pose.yaw,
    pose.pitch,
    pose.roll,
    pose.scale,
    width,
    height,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    width <= 0 ||
    height <= 0 ||
    pose.scale < 0
  ) {
    return hiddenPoint(width, height);
  }

  const localX = x * pose.scale;
  const localY = y * pose.scale;

  const cosRoll = Math.cos(pose.roll);
  const sinRoll = Math.sin(pose.roll);
  const rolledX = localX * cosRoll - localY * sinRoll;
  const rolledY = localX * sinRoll + localY * cosRoll;

  const cosPitch = Math.cos(pose.pitch);
  const sinPitch = Math.sin(pose.pitch);
  const pitchedY = rolledY * cosPitch;
  const pitchedZ = rolledY * sinPitch;

  const cosYaw = Math.cos(pose.yaw);
  const sinYaw = Math.sin(pose.yaw);
  const rotatedX = rolledX * cosYaw + pitchedZ * sinYaw;
  const rotatedZ = -rolledX * sinYaw + pitchedZ * cosYaw;

  const cameraDepth = pose.depth + rotatedZ;
  if (!Number.isFinite(cameraDepth) || cameraDepth <= NEAR_PLANE) {
    return hiddenPoint(width, height);
  }

  const focalLength = Math.min(width, height) * FOCAL_LENGTH_FACTOR;
  const projectedX =
    width / 2 +
    (focalLength * (pose.offsetX + rotatedX)) / cameraDepth;
  const projectedY =
    height / 2 -
    (focalLength * (pose.offsetY + pitchedY)) / cameraDepth;

  if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) {
    return hiddenPoint(width, height);
  }

  return { x: projectedX, y: projectedY, visible: true };
}
