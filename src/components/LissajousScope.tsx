import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  findCyclicTraceOffset,
  morphTracePointsInPlace,
  resampleCyclicTraceInto,
} from "../visuals/fractalFlightModel";

import { buildPhaseContourMesh } from "../visuals/phaseContourMesh";
import { sceneBufferSize, type SceneQuality } from "../visuals/phaseSurface";

export type LissajousScopeMode = "phase" | "harmonic";
export type PhasePreset = "classic" | "spatial";
export type PhaseProjection = "perspective" | "orthographic";

export interface LissajousScopeLayer {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  /** Optional pitch identity for consumers that preserve note history. */
  pitchClass?: number;
  label?: string;
  opacity?: number;
  lineWidth?: number;
  autoGain?: boolean;
  gain?: number;
}

export interface LissajousScopeProps {
  /** Add connections to the original trace; never replace its geometry. */
  phaseGeometry?: "lines" | "cage" | "surface";
  quality?: SceneQuality;
  /** X-axis samples. Typed arrays and regular number arrays are both supported. */
  x: ArrayLike<number>;
  /** Y-axis samples. Only pairs present in both arrays are rendered. */
  y: ArrayLike<number>;
  /** Additional traces rendered over the same grid in declaration order. */
  layers?: readonly LissajousScopeLayer[];
  mode?: LissajousScopeMode;
  title?: string;
  meta?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  color?: string;
  backgroundColor?: string;
  /** Keep old frames as a fading trail. `0` clears immediately; `1` fades slowly. */
  persistence?: number;
  /** Normalize the current pair of signals to the available drawing area. */
  autoGain?: boolean;
  gain?: number;
  lineWidth?: number;
  animate?: boolean;
  /** Optional animated layer shown behind the unchanged phase renderer. */
  backgroundLayer?: ReactNode;
  /** Diagnostic identity of the selected phase source composition. */
  phaseSourceMode?: "signal" | "notes" | "hybrid";
  /** Fraction of source points drawn for each phase trace. `1` is unchanged. */
  phaseDetail?: number;
  /** Temporal responsiveness of phase geometry. `1` is raw realtime input. */
  phaseSpeed?: number;
  /** Opacity of the complete phase overlay, including accumulated trails. */
  phaseOpacity?: number;
  /** Brightness of the complete phase overlay. `1` is unchanged. */
  phaseBrightness?: number;
  /** Multiplier for both the core and halo phase stroke widths. `1` is unchanged. */
  phaseLineWidth?: number;
  /** CSS blur in pixels applied to the complete phase overlay. */
  phaseBlur?: number;
  /** Multiplier for the phase halo only. `1` is unchanged; `0` disables it. */
  phaseGlow?: number;
  /** Phase geometry preset. `classic` preserves the original 2D renderer. */
  phasePreset?: PhasePreset;
  /** Projection used by the spatial preset. */
  phaseProjection?: PhaseProjection;
  /** Z-axis depth of the spatial phase geometry. */
  phaseDepth?: number;
  /** Normalized spatial camera tilt from `-1` to `1`. */
  phaseTilt?: number;
  /** Sound-reactive spatial rotation rate. `0` freezes rotation. */
  phaseRotation?: number;
  /** Amount of sound-reactive deformation applied along the Z axis. */
  phaseBend?: number;
  /** Optional raw signal RMS used by the spatial sound response. */
  phaseEnergy?: number;
  /** How strongly note layers diverge from the shared Y rotation axis. */
  phaseAxisDiversity?: number;
  /** Base rate of each spatial layer's independent rotation. */
  phaseLayerMotion?: number;
  /** Amount by which sound changes each layer's rotation speed. */
  phaseLayerSoundResponse?: number;
}

interface ScopeData {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  layers: readonly LissajousScopeLayer[];
}

interface ScopeOptions {
  geometry: "lines" | "cage" | "surface";
  meshStats?: { bridges: number; faces: number; linkedTraces: number };
  mode: LissajousScopeMode;
  color: string;
  backgroundColor: string;
  persistence: number;
  autoGain: boolean;
  gain: number;
  lineWidth: number;
  lineWidthScale: number;
  opacity: number;
  detail: number;
  speed: number;
  glowScale?: number;
  glowMultiplier: number;
  preset: PhasePreset;
  projection: PhaseProjection;
  spatialDepth: number;
  spatialTilt: number;
  spatialRotation: number;
  spatialBend: number;
  spatialAxisDiversity: number;
  spatialLayerMotion: number;
  spatialLayerSoundResponse: number;
  spatialEnergyInput?: number;
  spatialLayerIndex?: number;
  spatialLayerCount?: number;
  spatialLayerDepth?: number;
  spatialHarmonic?: number;
  spatialLayerAxis?: SpatialAxis;
  spatialLayerTravelAxis?: SpatialAxis;
  spatialLayerAngle?: number;
  spatialLayerTravel?: number;
  spatialLayerCenterDepth?: number;
  spatialFrame?: SpatialFrame;
}

interface ScopeSize {
  width: number;
  height: number;
  dpr: number;
}

interface SmoothedTrace {
  current: Float32Array;
  target: Float32Array;
  source: Float32Array;
  x: Float32Array;
  y: Float32Array;
  phaseOffset: number;
}

interface ScopeSmoothingState {
  traces: Map<string, SmoothedTrace>;
  lastTimestamp: number;
}

interface ScopePoint {
  x: number;
  y: number;
}

interface SpatialPoint extends ScopePoint {
  depth: number;
}

interface SpatialFrame {
  rotation: number;
  bendPhase: number;
  energy: number;
  elapsedSeconds: number;
}

interface SpatialMotionState extends SpatialFrame {
  velocity: number;
  lastTimestamp: number;
  layers: Map<string, SpatialLayerMotionState>;
}

interface SpatialAxis {
  x: number;
  y: number;
  z: number;
}

interface SpatialLayerMotionState {
  angle: number;
  velocity: number;
  response: number;
  direction: number;
  speedFactor: number;
  travelPhase: number;
  spinFactor: number;
}

const MAX_RENDERED_POINTS = 4096;
const MIN_AUTOGAIN_PEAK = 0.025;
const PHASE_SPLINE_STRENGTH = 0.72;
const SPATIAL_CAMERA_DISTANCE = 3.25;

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteSample(samples: ArrayLike<number>, index: number): number {
  const value = samples[index];
  return Number.isFinite(value) ? value : 0;
}

function signalEnergy(data: ScopeData): number {
  let squareSum = 0;
  let sampleCount = 0;
  const traces: Array<Pick<ScopeData, "x" | "y">> = [data, ...data.layers];

  for (const trace of traces) {
    const pointCount = Math.min(trace.x.length, trace.y.length);
    if (pointCount < 2) continue;
    const stride = Math.max(1, Math.floor(pointCount / 256));
    for (let index = 0; index < pointCount; index += stride) {
      const x = finiteSample(trace.x, index);
      const y = finiteSample(trace.y, index);
      squareSum += x * x + y * y;
      sampleCount += 2;
    }
  }

  if (sampleCount === 0) return 0;
  return clamp(Math.sqrt(squareSum / sampleCount) / 0.72, 0, 1);
}

function updateSpatialMotion(
  data: ScopeData,
  state: SpatialMotionState,
  rotationAmount: number,
  energyInput?: number,
): SpatialFrame {
  const now =
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const firstFrame = state.lastTimestamp <= 0;
  const elapsedMs = firstFrame ? 16 : clamp(now - state.lastTimestamp, 8, 80);
  state.lastTimestamp = now;

  const targetEnergy =
    energyInput === undefined
      ? signalEnergy(data)
      : clamp(energyInput, 0, 1);
  const responseMs = targetEnergy > state.energy ? 120 : 450;
  const smoothing = firstFrame
    ? 1
    : 1 - Math.exp(-elapsedMs / responseMs);
  state.energy += (targetEnergy - state.energy) * smoothing;

  const targetVelocity =
    clamp(rotationAmount, 0, 2) * (0.06 + state.energy * 0.14);
  state.velocity += (targetVelocity - state.velocity) * smoothing;
  const elapsedSeconds = elapsedMs / 1000;
  state.rotation =
    (state.rotation + state.velocity * elapsedSeconds) % (Math.PI * 2);
  state.bendPhase =
    (state.bendPhase +
      elapsedSeconds * (0.14 + state.energy * 0.42)) %
    (Math.PI * 2);
  state.elapsedSeconds = elapsedSeconds;

  return {
    rotation: state.rotation,
    bendPhase: state.bendPhase,
    energy: state.energy,
    elapsedSeconds,
  };
}

function stableHashUnit(value: string, salt: number): number {
  let hash = (2166136261 ^ salt) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4294967295;
}

function spatialLayerKey(
  layer: LissajousScopeLayer,
  index: number,
): string {
  if (layer.pitchClass !== undefined) {
    return `note:${((Math.round(layer.pitchClass) % 12) + 12) % 12}`;
  }
  return `signal:${layer.label ?? index}`;
}

function normalizeSpatialAxis(axis: SpatialAxis): SpatialAxis {
  const magnitude = Math.hypot(axis.x, axis.y, axis.z) || 1;
  return {
    x: axis.x / magnitude,
    y: axis.y / magnitude,
    z: axis.z / magnitude,
  };
}

function stableSpatialAxis(
  key: string,
  diversity: number,
  salt = 0,
): SpatialAxis {
  const amount = clamp(diversity, 0, 1);
  if (amount <= 0) return { x: 0, y: 1, z: 0 };

  const azimuth = stableHashUnit(key, 0x79a31 ^ salt) * Math.PI * 2;
  const vertical = stableHashUnit(key, 0x4f1bb ^ salt) * 1.4 - 0.7;
  const radial = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  const distinctAxis = {
    x: Math.cos(azimuth) * radial,
    y: vertical,
    z: Math.sin(azimuth) * radial,
  };
  return normalizeSpatialAxis({
    x: distinctAxis.x * amount,
    y: 1 + (distinctAxis.y - 1) * amount,
    z: distinctAxis.z * amount,
  });
}

function stableSpatialTravelAxis(
  key: string,
  diversity: number,
): SpatialAxis {
  return stableSpatialAxis(key, diversity, 0x6d2b79f5);
}

function spatialAxisSignature(axis: SpatialAxis): string {
  return `${axis.x.toFixed(3)},${axis.y.toFixed(3)},${axis.z.toFixed(3)}`;
}

function stableSpatialTravelPhase(key: string): number {
  return stableHashUnit(key, 0x27d4eb2f) * Math.PI * 2;
}

function traceMotionActivity(data: Pick<ScopeData, "x" | "y">): number {
  const pointCount = Math.min(data.x.length, data.y.length);
  if (pointCount < 2) return 0;
  const stride = Math.max(1, Math.floor(pointCount / 192));
  let squareSum = 0;
  let variation = 0;
  let peak = 0;
  let samples = 0;
  let previousX = finiteSample(data.x, 0);
  let previousY = finiteSample(data.y, 0);

  for (let index = 0; index < pointCount; index += stride) {
    const x = finiteSample(data.x, index);
    const y = finiteSample(data.y, index);
    squareSum += x * x + y * y;
    peak = Math.max(peak, Math.abs(x), Math.abs(y));
    if (samples > 0) variation += Math.hypot(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
    samples += 1;
  }

  if (samples === 0) return 0;
  const rms = clamp(Math.sqrt(squareSum / (samples * 2)) / 0.72, 0, 1);
  const normalizedVariation = clamp(
    variation / Math.max(0.001, (samples - 1) * peak * 0.42),
    0,
    1,
  );
  return clamp(rms * 0.58 + normalizedVariation * 0.42, 0, 1);
}

function updateSpatialLayerMotion(
  motionState: SpatialMotionState,
  key: string,
  data: Pick<ScopeData, "x" | "y">,
  frame: SpatialFrame,
  motionAmount: number,
  soundResponse: number,
): SpatialLayerMotionState {
  let layerState = motionState.layers.get(key);
  if (!layerState) {
    layerState = {
      angle: 0,
      velocity: 0,
      response: 0,
      direction: stableHashUnit(key, 0x9e3779b9) >= 0.5 ? 1 : -1,
      speedFactor: 0.7 + stableHashUnit(key, 0x85ebca6b) * 0.65,
      travelPhase: stableSpatialTravelPhase(key),
      spinFactor: 1 + stableHashUnit(key, 0x165667b1) * 0.6,
    };
    motionState.layers.set(key, layerState);
  }

  const localActivity = traceMotionActivity(data);
  const responseFactor = 0.72 + stableHashUnit(key, 0xc2b2ae35) * 0.58;
  const targetResponse = clamp(
    (frame.energy * 0.64 + localActivity * 0.36) * responseFactor,
    0,
    1.35,
  );
  const responseMs = targetResponse > layerState.response ? 140 : 520;
  const smoothing =
    1 - Math.exp(-(frame.elapsedSeconds * 1000) / responseMs);
  layerState.response +=
    (targetResponse - layerState.response) * smoothing;

  // Independent layer motion must remain clearly visible next to the shared
  // camera rotation. The previous 0.085 rad/s base was slower than the camera
  // by several times, so all layers appeared to orbit one common axis.
  const baseVelocity =
    0.22 * clamp(motionAmount, 0, 4) * layerState.speedFactor;
  const individualPulse =
    0.82 +
    Math.sin(layerState.angle * (1.15 + responseFactor * 0.35) +
      layerState.travelPhase) *
      0.18;
  const velocityMagnitude =
    baseVelocity *
    individualPulse *
    (1 + clamp(soundResponse, 0, 2) * layerState.response * 1.7);
  const targetVelocity = layerState.direction * velocityMagnitude;
  layerState.velocity +=
    (targetVelocity - layerState.velocity) * smoothing;
  layerState.angle =
    (layerState.angle + layerState.velocity * frame.elapsedSeconds) %
    (Math.PI * 2);
  return layerState;
}

function spatialLayerPosition(index: number, count: number): number {
  if (count <= 1) return 0;
  return (index / (count - 1)) * 2 - 1;
}

function stableSpatialLayerDepth(
  layer: LissajousScopeLayer,
  fallbackIndex: number,
  fallbackCount: number,
): number {
  if (layer.pitchClass !== undefined) {
    const pitchClass =
      ((Math.round(layer.pitchClass) % 12) + 12) % 12;
    return (pitchClass / 11) * 2 - 1;
  }
  return spatialLayerPosition(fallbackIndex, fallbackCount);
}

function rotateAroundSpatialAxis(
  x: number,
  y: number,
  z: number,
  axis: SpatialAxis,
  angle: number,
): { x: number; y: number; z: number } {
  if (Math.abs(angle) < 1e-8) return { x, y, z };
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dot = axis.x * x + axis.y * y + axis.z * z;
  return {
    x:
      x * cosine +
      (axis.y * z - axis.z * y) * sine +
      axis.x * dot * (1 - cosine),
    y:
      y * cosine +
      (axis.z * x - axis.x * z) * sine +
      axis.y * dot * (1 - cosine),
    z:
      z * cosine +
      (axis.x * y - axis.y * x) * sine +
      axis.z * dot * (1 - cosine),
  };
}

function projectSpatialPoint(
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  plotSize: number,
  options: ScopeOptions,
): SpatialPoint {
  const frame = options.spatialFrame ?? {
    rotation: 0,
    bendPhase: 0,
    energy: 0,
    elapsedSeconds: 0,
  };
  const rotation = frame.rotation;
  const tilt =
    options.spatialTilt * (Math.PI / 3) +
    Math.sin(frame.bendPhase * 0.74) *
      options.spatialBend *
      frame.energy *
      0.075;
  const rotationCosine = Math.cos(rotation);
  const rotationSine = Math.sin(rotation);
  const tiltCosine = Math.cos(tilt);
  const tiltSine = Math.sin(tilt);

  const layerAxis =
    options.spatialLayerAxis ?? { x: 0, y: 1, z: 0 };
  const travelAxis = options.spatialLayerTravelAxis ?? layerAxis;
  const layerCenterDepth = options.spatialLayerCenterDepth ?? 0;
  const spunPoint = rotateAroundSpatialAxis(
    x,
    y,
    z - layerCenterDepth,
    layerAxis,
    options.spatialLayerAngle ?? 0,
  );
  const layerTravel = options.spatialLayerTravel ?? 0;
  // Move the whole contour along its stable axis. Rotating points around an
  // axis through the origin only spins the contour in place and does not read
  // as independent spatial movement.
  const localPoint = {
    x: spunPoint.x + travelAxis.x * layerTravel,
    y: spunPoint.y + travelAxis.y * layerTravel,
    z:
      spunPoint.z +
      layerCenterDepth +
      travelAxis.z * layerTravel,
  };
  const rotatedX =
    localPoint.x * rotationCosine + localPoint.z * rotationSine;
  const rotatedZ =
    -localPoint.x * rotationSine + localPoint.z * rotationCosine;
  const tiltedY = localPoint.y * tiltCosine - rotatedZ * tiltSine;
  const tiltedZ = localPoint.y * tiltSine + rotatedZ * tiltCosine;
  const perspective =
    options.projection === "perspective"
      ? clamp(
          SPATIAL_CAMERA_DISTANCE /
            Math.max(1.25, SPATIAL_CAMERA_DISTANCE - tiltedZ),
          0.56,
          1.72,
        )
      : 1;
  const scale = (plotSize / 2) * 0.76 * perspective;

  return {
    x: width / 2 + rotatedX * scale,
    y: height / 2 - tiltedY * scale,
    depth: tiltedZ,
  };
}

function renderedPointCount(pointCount: number, detail: number): number {
  if (pointCount < 2) return pointCount;
  const cappedCount = Math.min(pointCount, MAX_RENDERED_POINTS);
  return Math.max(2, Math.round(cappedCount * clamp(detail, 0.05, 1)));
}

function phaseSmoothingTimeMs(speed: number): number {
  const response = clamp(speed, 0, 1);
  if (response >= 0.999) return 0;
  return 40 + (1 - response) * (1 - response) * 3960;
}

function phaseDensityResponse(
  traceCount: number,
  detail: number,
  persistence: number,
  mode: LissajousScopeMode,
) {
  if (mode !== "phase") {
    return { glowScale: 1, persistence };
  }

  const crowding = clamp((traceCount - 1) / 3, 0, 1);
  const detailLoss = (1 - clamp(detail, 0.05, 1)) * crowding;
  return {
    glowScale: 1 - 0.65 * detailLoss,
    persistence: persistence * (1 - 0.45 * detailLoss),
  };
}

function smoothingTraceKey(
  layer: LissajousScopeLayer,
  index: number,
): string {
  if (layer.pitchClass !== undefined) {
    return `note:${((Math.round(layer.pitchClass) % 12) + 12) % 12}`;
  }
  return `layer:${layer.label ?? index}`;
}

function fillInterleaved(
  target: Float32Array,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
) {
  const pointCount = Math.min(x.length, y.length, target.length / 2);
  for (let index = 0; index < pointCount; index += 1) {
    target[index * 2] = finiteSample(x, index);
    target[index * 2 + 1] = finiteSample(y, index);
  }
}

function createSmoothedTrace(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
): SmoothedTrace {
  const pointCount = Math.min(x.length, y.length);
  const current = new Float32Array(pointCount * 2);
  fillInterleaved(current, x, y);
  const trace: SmoothedTrace = {
    current,
    target: current.slice(),
    source: current.slice(),
    x: new Float32Array(pointCount),
    y: new Float32Array(pointCount),
    phaseOffset: Number.NaN,
  };
  for (let index = 0; index < pointCount; index += 1) {
    trace.x[index] = current[index * 2];
    trace.y[index] = current[index * 2 + 1];
  }
  return trace;
}

function seedSmoothedTrace(
  trace: SmoothedTrace,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
) {
  fillInterleaved(trace.current, x, y);
  trace.target.set(trace.current);
  trace.source.set(trace.current);
  trace.phaseOffset = Number.NaN;
}

function splitSmoothedTrace(trace: SmoothedTrace) {
  for (let index = 0; index < trace.x.length; index += 1) {
    trace.x[index] = trace.current[index * 2];
    trace.y[index] = trace.current[index * 2 + 1];
  }
}

function smoothScopeData(
  data: ScopeData,
  state: ScopeSmoothingState,
  speed: number,
  alignCyclicAtRealtime = false,
): ScopeData {
  const normalizedSpeed = clamp(speed, 0, 1);
  const now =
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const elapsedMs =
    state.lastTimestamp > 0
      ? clamp(now - state.lastTimestamp, 8, 160)
      : 32;
  state.lastTimestamp = now;
  const direct = normalizedSpeed >= 0.999;
  const smoothingTimeMs = phaseSmoothingTimeMs(normalizedSpeed);
  const interpolation = direct
    ? 1
    : 1 - Math.exp(-elapsedMs / smoothingTimeMs);
  const activeKeys = new Set<string>();

  const resolveTrace = (
    key: string,
    x: ArrayLike<number>,
    y: ArrayLike<number>,
  ): Pick<ScopeData, "x" | "y"> => {
    activeKeys.add(key);
    const pointCount = Math.min(x.length, y.length);
    let trace = state.traces.get(key);
    if (!trace || trace.x.length !== pointCount) {
      trace = createSmoothedTrace(x, y);
      state.traces.set(key, trace);
      return direct && !alignCyclicAtRealtime
        ? { x, y }
        : { x: trace.x, y: trace.y };
    }

    if (direct && !alignCyclicAtRealtime) {
      seedSmoothedTrace(trace, x, y);
      return { x, y };
    }

    fillInterleaved(trace.source, x, y);
    trace.phaseOffset = findCyclicTraceOffset(
      trace.current,
      trace.source,
      trace.phaseOffset,
    );
    resampleCyclicTraceInto(
      trace.target,
      trace.source,
      trace.phaseOffset,
    );
    morphTracePointsInPlace(
      trace.current,
      trace.target,
      direct ? 1 : interpolation,
    );
    splitSmoothedTrace(trace);
    return { x: trace.x, y: trace.y };
  };

  const main = resolveTrace("main", data.x, data.y);
  const layers = data.layers.map((layer, index) => ({
    ...layer,
    ...resolveTrace(smoothingTraceKey(layer, index), layer.x, layer.y),
  }));

  for (const key of state.traces.keys()) {
    if (!activeKeys.has(key)) state.traces.delete(key);
  }

  return { ...main, layers };
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  plotSize: number,
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = plotSize / 2;

  context.save();
  context.lineWidth = 1;
  context.strokeStyle = "rgba(180, 199, 255, 0.085)";
  context.beginPath();
  context.ellipse(centerX, centerY, radius, radius, 0, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = "rgba(180, 199, 255, 0.12)";
  context.beginPath();
  context.moveTo(centerX - radius, centerY);
  context.lineTo(centerX + radius, centerY);
  context.moveTo(centerX, centerY - radius);
  context.lineTo(centerX, centerY + radius);
  context.stroke();

  context.fillStyle = "rgba(205, 218, 255, 0.28)";
  context.beginPath();
  context.arc(centerX, centerY, 1.25, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawSpatialGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  plotSize: number,
  options: ScopeOptions,
) {
  context.save();
  context.lineWidth = 1;

  const ringDepths = [-0.48, 0, 0.48];
  for (const depthPosition of ringDepths) {
    context.strokeStyle =
      depthPosition === 0
        ? "rgba(180, 199, 255, 0.1)"
        : "rgba(180, 199, 255, 0.055)";
    context.beginPath();
    for (let index = 0; index <= 64; index += 1) {
      const angle = (index / 64) * Math.PI * 2;
      const point = projectSpatialPoint(
        Math.cos(angle) * 0.94,
        Math.sin(angle) * 0.94,
        depthPosition * options.spatialDepth,
        width,
        height,
        plotSize,
        options,
      );
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
    context.closePath();
    context.stroke();
  }

  context.strokeStyle = "rgba(180, 199, 255, 0.105)";
  for (const axis of [
    [-0.98, 0, 0, 0.98, 0, 0],
    [0, -0.98, 0, 0, 0.98, 0],
    [0, 0, -0.72, 0, 0, 0.72],
  ] as const) {
    const start = projectSpatialPoint(
      axis[0],
      axis[1],
      axis[2] * options.spatialDepth,
      width,
      height,
      plotSize,
      options,
    );
    const end = projectSpatialPoint(
      axis[3],
      axis[4],
      axis[5] * options.spatialDepth,
      width,
      height,
      plotSize,
      options,
    );
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }

  const center = projectSpatialPoint(
    0,
    0,
    0,
    width,
    height,
    plotSize,
    options,
  );
  context.fillStyle = "rgba(205, 218, 255, 0.34)";
  context.beginPath();
  context.arc(center.x, center.y, 1.35, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function traceClosedCardinalSpline(
  context: CanvasRenderingContext2D,
  points: readonly ScopePoint[],
  closed = true,
) {
  const pointCount = points.length;
  if (pointCount < 3) {
    for (let index = 1; index < pointCount; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }
    return;
  }

  const controlScale = PHASE_SPLINE_STRENGTH / 6;
  for (let index = 0; index < pointCount - (closed ? 0 : 1); index += 1) {
    const previous = points[closed ? (index - 1 + pointCount) % pointCount : Math.max(0,index-1)];
    const current = points[index];
    const next = points[(index + 1) % pointCount];
    const following = points[closed ? (index + 2) % pointCount : Math.min(pointCount-1,index+2)];

    context.bezierCurveTo(
      current.x + (next.x - previous.x) * controlScale,
      current.y + (next.y - previous.y) * controlScale,
      next.x - (following.x - current.x) * controlScale,
      next.y - (following.y - current.y) * controlScale,
      next.x,
      next.y,
    );
  }
}

function strokeSpatialDepthBuckets(
  context: CanvasRenderingContext2D,
  points: readonly SpatialPoint[],
  options: ScopeOptions,
) {
  const pointCount = points.length;
  const bucketCount = 6;
  const closed = options.mode === "harmonic";
  let minimumDepth = Number.POSITIVE_INFINITY;
  let maximumDepth = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minimumDepth = Math.min(minimumDepth, point.depth);
    maximumDepth = Math.max(maximumDepth, point.depth);
  }
  const depthRange = Math.max(0.001, maximumDepth - minimumDepth);
  const buckets = Array.from({ length: bucketCount }, () => [] as number[]);

  for (let index = 0; index < pointCount - (closed ? 0 : 1); index += 1) {
    const next = points[(index + 1) % pointCount];
    const segmentDepth = (points[index].depth + next.depth) / 2;
    const normalizedDepth = clamp(
      (segmentDepth - minimumDepth) / depthRange,
      0,
      0.999999,
    );
    buckets[Math.floor(normalizedDepth * bucketCount)].push(index);
  }

  const controlScale = PHASE_SPLINE_STRENGTH / 6;
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const segmentIndices = buckets[bucketIndex];
    if (segmentIndices.length === 0) continue;

    let bucketDepth = 0;
    context.beginPath();
    for (const index of segmentIndices) {
      const previous = points[closed ? (index - 1 + pointCount) % pointCount : Math.max(0,index-1)];
      const current = points[index];
      const next = points[(index + 1) % pointCount];
      const following = points[closed ? (index + 2) % pointCount : Math.min(pointCount-1,index+2)];
      bucketDepth += (current.depth + next.depth) / 2;
      context.moveTo(current.x, current.y);
      context.bezierCurveTo(
        current.x + (next.x - previous.x) * controlScale,
        current.y + (next.y - previous.y) * controlScale,
        next.x - (following.x - current.x) * controlScale,
        next.y - (following.y - current.y) * controlScale,
        next.x,
        next.y,
      );
    }

    const meanDepth = bucketDepth / segmentIndices.length;
    const normalizedMeanDepth =
      (meanDepth - minimumDepth) / depthRange;
    const localDepthCue = 0.6 + normalizedMeanDepth * 0.54;
    const cameraDepthCue = clamp(0.9 + meanDepth * 0.16, 0.68, 1.22);
    const depthCue = localDepthCue * cameraDepthCue;
    const glowScale = clamp(options.glowScale ?? 1, 0.25, 1);
    const haloScale =
      (0.45 + 0.55 * glowScale) * options.glowMultiplier;

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = options.color;
    context.lineWidth =
      (options.lineWidth + 1.4 * haloScale) *
      options.lineWidthScale *
      depthCue;
    const haloAlpha = options.mode === "harmonic" ? 0.42 : 0.3;
    context.globalAlpha = clamp(
      haloAlpha *
        options.opacity *
        glowScale *
        options.glowMultiplier *
        depthCue,
      0,
      1,
    );
    context.shadowColor = options.color;
    context.shadowBlur =
      (options.mode === "harmonic" ? 20 : 14) *
      haloScale *
      depthCue;
    context.stroke();

    context.globalAlpha = clamp(
      0.92 * options.opacity * depthCue,
      0,
      1,
    );
    context.shadowBlur = 4;
    context.lineWidth =
      options.lineWidth * options.lineWidthScale * depthCue;
    context.stroke();
    context.restore();
  }
}

/** Attach neighbouring turns inside this very trace, before drawing its original strokes. */
function drawContourConnections(
  context: CanvasRenderingContext2D,
  data: Pick<ScopeData, "x" | "y">,
  points: readonly SpatialPoint[],
  sampleIndices: number[],
  options: ScopeOptions,
) {
  if (options.mode !== "phase" || options.geometry === "lines") return;
  const mesh = buildPhaseContourMesh({ ...data, sampleIndices, maxBridges: 96, maxFaces: options.geometry === "surface" ? 600 : 0 });
  if (!mesh.bridges.length) return;
  if (options.meshStats) {
    options.meshStats.bridges += mesh.bridges.length;
    options.meshStats.linkedTraces += 1;
  }
  context.save();
  context.fillStyle = options.color;
  context.strokeStyle = options.color;
  context.lineJoin = "round";
  context.lineCap = "round";
  if (options.geometry === "surface") {
    // Depth comes from the original spatial deformation/projection. The mesh
    // introduces no independent camera, generated contour or history clock.
    const faces = mesh.quads.map(indices => ({
      vertices: indices.map(index => points[index]),
      depth: indices.reduce((sum, index) => sum + points[index].depth, 0) / 4,
    })).sort((a, b) => a.depth - b.depth);
    context.shadowBlur = 0;
    for (const face of faces) {
      const [a, b, , d] = face.vertices;
      const area = Math.abs((b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x));
      if (area < 0.03) continue;
      context.globalAlpha = options.opacity * clamp(0.095 + face.depth * 0.035, 0.045, 0.18);
      context.beginPath();
      face.vertices.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.closePath();
      context.fill();
      if (options.meshStats) options.meshStats.faces += 1;
    }
  }
  context.beginPath();
  for (const [from, to] of mesh.bridges) {
    context.moveTo(points[from].x, points[from].y);
    context.lineTo(points[to].x, points[to].y);
  }
  context.lineWidth = options.lineWidth * options.lineWidthScale * 0.65;
  context.globalAlpha = options.opacity * 0.42;
  context.shadowColor = options.color;
  context.shadowBlur = 3 * options.glowMultiplier;
  context.stroke();
  context.restore();
}

function tracePath(
  context: CanvasRenderingContext2D,
  data: Pick<ScopeData, "x" | "y">,
  width: number,
  height: number,
  plotSize: number,
  options: ScopeOptions,
): boolean {
  const pointCount = Math.min(data.x.length, data.y.length);
  if (pointCount < 2) return false;

  const sampleCount = renderedPointCount(pointCount, options.detail);
  const sampleIndex = (index: number) =>
    sampleCount === 1
      ? 0
      : Math.round((index * (pointCount - 1)) / (sampleCount - 1));
  let sumX = 0;
  let sumY = 0;
  let finiteCount = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = sampleIndex(index);
    const x = finiteSample(data.x, sourceIndex);
    const y = finiteSample(data.y, sourceIndex);
    sumX += x;
    sumY += y;
    finiteCount += 1;
  }

  if (finiteCount < 2) return false;

  const meanX = sumX / finiteCount;
  const meanY = sumY / finiteCount;
  let peak = 0;

  if (options.autoGain) {
    for (let index = 0; index < sampleCount; index += 1) {
      const sourceIndex = sampleIndex(index);
      peak = Math.max(
        peak,
        Math.abs(finiteSample(data.x, sourceIndex) - meanX),
        Math.abs(finiteSample(data.y, sourceIndex) - meanY),
      );
    }
  }

  const normalizedGain = options.autoGain
    ? 0.92 / Math.max(peak, MIN_AUTOGAIN_PEAK)
    : options.gain;
  const scale = (plotSize / 2) * normalizedGain;
  const centerX = width / 2;
  const centerY = height / 2;

  const pathPoints: SpatialPoint[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = sampleIndex(index);
    if (options.preset === "spatial") {
      const normalizedX = clamp(
        (finiteSample(data.x, sourceIndex) - meanX) * normalizedGain,
        -1.5,
        1.5,
      );
      const normalizedY = clamp(
        (finiteSample(data.y, sourceIndex) - meanY) * normalizedGain,
        -1.5,
        1.5,
      );
      const frame = options.spatialFrame ?? {
        rotation: 0,
        bendPhase: 0,
        energy: 0,
        elapsedSeconds: 0,
      };
      const layerPosition = spatialLayerPosition(
        options.spatialLayerIndex ?? 0,
        options.spatialLayerCount ?? 1,
      );
      const resolvedLayerPosition =
        options.spatialLayerDepth ?? layerPosition;
      const pathPhase =
        sampleCount > 1
          ? (index / sampleCount) * Math.PI * 2
          : 0;
      const spatialHarmonic =
        options.spatialHarmonic ??
        2 + ((options.spatialLayerIndex ?? 0) % 3);
      const deformation =
        Math.sin(
            spatialHarmonic * pathPhase +
            frame.bendPhase +
            resolvedLayerPosition * 1.2,
        ) *
          0.2 +
        Math.sin(
          (spatialHarmonic + 1) * pathPhase -
            frame.bendPhase * 0.7,
        ) *
          0.09;
      const z =
        options.spatialDepth *
        (resolvedLayerPosition * 0.58 +
          deformation *
            options.spatialBend *
            (0.42 + frame.energy * 0.58));
      const projected = projectSpatialPoint(
        normalizedX,
        normalizedY,
        z,
        width,
        height,
        plotSize,
        options,
      );
      pathPoints.push(projected);
    } else {
      const x = clamp(
        (finiteSample(data.x, sourceIndex) - meanX) * scale,
        -plotSize,
        plotSize,
      );
      const y = clamp(
        (finiteSample(data.y, sourceIndex) - meanY) * scale,
        -plotSize,
        plotSize,
      );
      const canvasX = centerX + x;
      const canvasY = centerY - y;

      pathPoints.push({ x: canvasX, y: canvasY, depth: 0 });
    }
  }

  if (pathPoints.length < 2) return false;
  if (options.mode === "phase" && options.geometry !== "lines") {
    drawContourConnections(context, data, pathPoints, Array.from({ length: sampleCount }, (_, i) => sampleIndex(i)), options);
  }

  if (options.preset === "spatial") {
    strokeSpatialDepthBuckets(context, pathPoints, options);
    return true;
  }

  context.beginPath();
  context.moveTo(pathPoints[0].x, pathPoints[0].y);
  if (
    options.mode === "phase" &&
    options.detail < 0.999
  ) {
    traceClosedCardinalSpline(context, pathPoints, false);
  } else {
    for (let index = 1; index < pathPoints.length; index += 1) {
      context.lineTo(pathPoints[index].x, pathPoints[index].y);
    }
  }
  if (options.mode === "harmonic") context.closePath();

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = options.color;
  const depthCue = 1;
  const glowScale = clamp(options.glowScale ?? 1, 0.25, 1);
  const haloScale =
    (0.45 + 0.55 * glowScale) * options.glowMultiplier;
  context.lineWidth =
    (options.lineWidth + 1.4 * haloScale) *
    options.lineWidthScale *
    depthCue;
  const haloAlpha = options.mode === "harmonic" ? 0.42 : 0.3;
  context.globalAlpha = clamp(
    haloAlpha *
      (options.opacity * glowScale) *
      options.glowMultiplier *
      depthCue,
    0,
    1,
  );
  context.shadowColor = options.color;
  context.shadowBlur =
    (options.mode === "harmonic" ? 20 : 14) * haloScale * depthCue;
  context.stroke();

  context.globalAlpha = clamp(0.92 * options.opacity * depthCue, 0, 1);
  context.shadowBlur = 4;
  context.lineWidth =
    options.lineWidth * options.lineWidthScale * depthCue;
  context.stroke();
  context.restore();
  return true;
}

function paintScope(
  canvas: HTMLCanvasElement,
  data: ScopeData,
  size: ScopeSize,
  options: ScopeOptions,
  hardClear: boolean,
  spatialMotionState: SpatialMotionState,
) {
  const context = canvas.getContext("2d");
  if (!context || size.width <= 0 || size.height <= 0) return;

  const visibleTraceCount =
    (Math.min(data.x.length, data.y.length) >= 2 ? 1 : 0) +
    data.layers.filter(
      (layer) => Math.min(layer.x.length, layer.y.length) >= 2,
    ).length;
  const densityResponse = phaseDensityResponse(
    visibleTraceCount,
    options.detail,
    options.persistence,
    options.mode,
  );
  const spatialFrame =
    options.preset === "spatial"
      ? updateSpatialMotion(
          data,
          spatialMotionState,
          options.spatialRotation,
          options.spatialEnergyInput,
        )
      : undefined;
  if (options.preset === "spatial" && spatialFrame) {
    canvas.dataset.phaseEnergy = spatialFrame.energy.toFixed(3);
  }
  const meshStats = { bridges: 0, faces: 0, linkedTraces: 0 };
  const publishMeshStats = () => {
    canvas.dataset.phaseBridges = String(meshStats.bridges);
    canvas.dataset.phaseFaces = String(meshStats.faces);
    canvas.dataset.phaseLinkedTraces = String(meshStats.linkedTraces);
  };
  const renderOptions: ScopeOptions = {
    meshStats,
    ...options,
    glowScale: densityResponse.glowScale,
    spatialFrame,
  };

  context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  context.save();
  if (hardClear) {
    context.clearRect(0, 0, size.width, size.height);
  } else {
    // Keep the phase canvas transparent so changing the visual background
    // never changes, replaces, or downsamples the phase portrait itself.
    context.globalCompositeOperation = "destination-out";
    context.globalAlpha = Math.max(0.035, 1 - densityResponse.persistence);
    context.fillStyle = "#000";
    context.fillRect(0, 0, size.width, size.height);
  }
  context.restore();

  const plotSize = Math.max(1, Math.min(size.width, size.height) - 30);
  if (options.preset === "classic") {
    drawGrid(context, size.width, size.height, plotSize);
    tracePath(context, data, size.width, size.height, plotSize, renderOptions);
    for (const layer of data.layers) {
      tracePath(
        context,
        layer,
        size.width,
        size.height,
        plotSize,
        {
          ...renderOptions,
          color: layer.color,
          opacity: clamp(layer.opacity ?? 0.9, 0, 1),
          lineWidth: Math.max(0.5, layer.lineWidth ?? options.lineWidth),
          autoGain: layer.autoGain ?? options.autoGain,
          gain: Math.max(0, layer.gain ?? options.gain),
        },
      );
    }
    publishMeshStats();
    return;
  }

  drawSpatialGrid(
    context,
    size.width,
    size.height,
    plotSize,
    renderOptions,
  );

  const spatialTraces: Array<{
    data: Pick<ScopeData, "x" | "y">;
    options: ScopeOptions;
  }> = [];
  const activeSpatialLayerKeys = new Set<string>();
  const independentMotionOptions = (
    key: string,
    traceData: Pick<ScopeData, "x" | "y">,
    layerCenterDepth: number,
  ): Pick<
    ScopeOptions,
    | "spatialLayerAxis"
    | "spatialLayerTravelAxis"
    | "spatialLayerAngle"
    | "spatialLayerTravel"
    | "spatialLayerCenterDepth"
  > => {
    activeSpatialLayerKeys.add(key);
    const layerMotion = updateSpatialLayerMotion(
      spatialMotionState,
      key,
      traceData,
      spatialFrame ?? {
        rotation: 0,
        bendPhase: 0,
        energy: 0,
        elapsedSeconds: 0,
      },
      options.spatialLayerMotion,
      options.spatialLayerSoundResponse,
    );
    const motionStrength = clamp(options.spatialLayerMotion, 0, 4);
    const travelStrength = Math.min(2, motionStrength);
    const travelAmplitude =
      travelStrength *
      (0.12 + clamp(options.spatialAxisDiversity, 0, 1) * 0.1) *
      (0.86 + stableHashUnit(key, 0xd3a2646c) * 0.28) *
      (0.86 + (spatialFrame?.energy ?? 0) * 0.14);
    return {
      spatialLayerAxis: stableSpatialAxis(
        key,
        options.spatialAxisDiversity,
      ),
      spatialLayerTravelAxis: stableSpatialTravelAxis(
        key,
        options.spatialAxisDiversity,
      ),
      // Spin uses a separate axis and stays deliberately fast enough to remain
      // visible even next to the shared camera motion.
      spatialLayerAngle: layerMotion.angle * layerMotion.spinFactor,
      spatialLayerTravel:
        Math.sin(layerMotion.angle + layerMotion.travelPhase) *
        travelAmplitude,
      spatialLayerCenterDepth: layerCenterDepth,
    };
  };
  let spatialLayerIndex = 0;
  if (Math.min(data.x.length, data.y.length) >= 2) {
    spatialTraces.push({
      data,
      options: {
        ...renderOptions,
        spatialLayerIndex,
        spatialLayerCount: visibleTraceCount,
        spatialLayerDepth: 0,
        spatialHarmonic: 2,
        ...independentMotionOptions("main", data, 0),
      },
    });
    spatialLayerIndex += 1;
  }
  for (const [sourceLayerIndex, layer] of data.layers.entries()) {
    if (Math.min(layer.x.length, layer.y.length) < 2) continue;
    const layerKey = spatialLayerKey(layer, sourceLayerIndex);
    const layerPosition = stableSpatialLayerDepth(
      layer,
      spatialLayerIndex,
      visibleTraceCount,
    );
    spatialTraces.push({
      data: layer,
      options: {
        ...renderOptions,
        color: layer.color,
        opacity: clamp(layer.opacity ?? 0.9, 0, 1),
        lineWidth: Math.max(0.5, layer.lineWidth ?? options.lineWidth),
        autoGain: layer.autoGain ?? options.autoGain,
        gain: Math.max(0, layer.gain ?? options.gain),
        spatialLayerIndex,
        spatialLayerCount: visibleTraceCount,
        spatialLayerDepth: layerPosition,
        spatialHarmonic:
          2 +
          (((Math.round(layer.pitchClass ?? spatialLayerIndex) % 3) + 3) %
            3),
        ...independentMotionOptions(
          layerKey,
          layer,
          options.spatialDepth * layerPosition * 0.58,
        ),
      },
    });
    spatialLayerIndex += 1;
  }

  for (const key of spatialMotionState.layers.keys()) {
    if (!activeSpatialLayerKeys.has(key)) spatialMotionState.layers.delete(key);
  }

  // Draw far contours first. Independent travel can move a layer in front of
  // another one, so the old static layerPosition sort is no longer sufficient.
  const centerDepth = (trace: (typeof spatialTraces)[number]) =>
    projectSpatialPoint(
      0,
      0,
      trace.options.spatialLayerCenterDepth ?? 0,
      size.width,
      size.height,
      plotSize,
      trace.options,
    ).depth;
  spatialTraces.sort(
    (left, right) => centerDepth(left) - centerDepth(right),
  );
  for (const trace of spatialTraces) {
    tracePath(
      context,
      trace.data,
      size.width,
      size.height,
      plotSize,
      trace.options,
    );
  }
  publishMeshStats();
}

function motionIsReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function LissajousScope({
  phaseGeometry = "lines",
  quality = "auto",
  x,
  y,
  layers = [],
  mode = "phase",
  title,
  meta,
  ariaLabel,
  className,
  style,
  color,
  backgroundColor = "#070a12",
  persistence = 0.86,
  autoGain = true,
  gain = 1,
  lineWidth = 1.45,
  animate = true,
  backgroundLayer,
  phaseSourceMode,
  phaseDetail = 1,
  phaseSpeed = 1,
  phaseOpacity = 1,
  phaseBrightness = 1,
  phaseLineWidth = 1,
  phaseBlur = 0,
  phaseGlow = 1,
  phasePreset = "classic",
  phaseProjection = "perspective",
  phaseDepth = 1,
  phaseTilt = 0,
  phaseRotation = 0,
  phaseBend = 0,
  phaseEnergy,
  phaseAxisDiversity = 0,
  phaseLayerMotion = 0,
  phaseLayerSoundResponse = 0,
}: LissajousScopeProps) {
  const resolvedPhaseDetail = clamp(phaseDetail, 0.05, 1);
  const resolvedPhaseSpeed = clamp(phaseSpeed, 0, 1);
  const resolvedPhaseOpacity = clamp(phaseOpacity, 0, 1);
  const resolvedPhaseBrightness = clamp(phaseBrightness, 0, 3);
  const resolvedPhaseLineWidth = clamp(phaseLineWidth, 0.5, 5);
  const resolvedPhaseBlur = clamp(phaseBlur, 0, 8);
  const resolvedPhaseGlow = clamp(phaseGlow, 0, 4);
  const resolvedPhaseDepth = clamp(phaseDepth, 0, 1.5);
  const resolvedPhaseTilt = clamp(phaseTilt, -1, 1);
  const resolvedPhaseRotation = clamp(phaseRotation, 0, 2);
  const resolvedPhaseBend = clamp(phaseBend, 0, 1.5);
  const resolvedPhaseAxisDiversity = clamp(phaseAxisDiversity, 0, 1);
  const resolvedPhaseLayerMotion = clamp(phaseLayerMotion, 0, 4);
  const resolvedPhaseLayerSoundResponse = clamp(
    phaseLayerSoundResponse,
    0,
    2,
  );
  const resolvedPhaseEnergy =
    phaseEnergy === undefined ? undefined : clamp(phaseEnergy, 0, 1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<ScopeSize>({ width: 0, height: 0, dpr: 1 });
  const hardClearRef = useRef(true);
  const previousDetailRef = useRef(resolvedPhaseDetail);
  const previousPresetRef = useRef(
    `${phasePreset}:${phaseProjection}:${resolvedPhaseAxisDiversity}:${phaseGeometry}`,
  );
  const smoothingRef = useRef<ScopeSmoothingState>({
    traces: new Map(),
    lastTimestamp: 0,
  });
  const spatialMotionRef = useRef<SpatialMotionState>({
    rotation: 0,
    bendPhase: 0,
    energy: 0,
    elapsedSeconds: 0,
    velocity: 0,
    lastTimestamp: 0,
    layers: new Map(),
  });
  const dataRef = useRef<ScopeData>({ x, y, layers });
  const optionsRef = useRef<ScopeOptions>({
    geometry: phaseGeometry,
    mode,
    color: color ?? (mode === "harmonic" ? "#8f7cff" : "#55e6d0"),
    backgroundColor,
    persistence: clamp(persistence, 0, 0.965),
    autoGain,
    gain: Math.max(0, gain),
    lineWidth: Math.max(0.5, lineWidth),
    lineWidthScale: resolvedPhaseLineWidth,
    opacity: 1,
    detail: resolvedPhaseDetail,
    speed: resolvedPhaseSpeed,
    glowMultiplier: resolvedPhaseGlow,
    preset: phasePreset,
    projection: phaseProjection,
    spatialDepth: resolvedPhaseDepth,
    spatialTilt: resolvedPhaseTilt,
    spatialRotation: resolvedPhaseRotation,
    spatialBend: resolvedPhaseBend,
    spatialAxisDiversity: resolvedPhaseAxisDiversity,
    spatialLayerMotion: resolvedPhaseLayerMotion,
    spatialLayerSoundResponse: resolvedPhaseLayerSoundResponse,
    spatialEnergyInput: resolvedPhaseEnergy,
  });
  const titleId = useId();
  const descriptionId = useId();

  dataRef.current = { x, y, layers };
  if (previousDetailRef.current !== resolvedPhaseDetail) {
    previousDetailRef.current = resolvedPhaseDetail;
    hardClearRef.current = true;
  }
  const presetKey =
    `${phasePreset}:${phaseProjection}:${resolvedPhaseAxisDiversity}:${phaseGeometry}`;
  if (previousPresetRef.current !== presetKey) {
    previousPresetRef.current = presetKey;
    hardClearRef.current = true;
  }
  optionsRef.current = {
    geometry: phaseGeometry,
    mode,
    color: color ?? (mode === "harmonic" ? "#8f7cff" : "#55e6d0"),
    backgroundColor,
    persistence: clamp(persistence, 0, 0.965),
    autoGain,
    gain: Math.max(0, gain),
    lineWidth: Math.max(0.5, lineWidth),
    lineWidthScale: resolvedPhaseLineWidth,
    opacity: 1,
    detail: resolvedPhaseDetail,
    speed: resolvedPhaseSpeed,
    glowMultiplier: resolvedPhaseGlow,
    preset: phasePreset,
    projection: phaseProjection,
    spatialDepth: resolvedPhaseDepth,
    spatialTilt: resolvedPhaseTilt,
    spatialRotation: resolvedPhaseRotation,
    spatialBend: resolvedPhaseBend,
    spatialAxisDiversity: resolvedPhaseAxisDiversity,
    spatialLayerMotion: resolvedPhaseLayerMotion,
    spatialLayerSoundResponse: resolvedPhaseLayerSoundResponse,
    spatialEnergyInput: resolvedPhaseEnergy,
  };

  const resolvedTitle =
    title ?? (mode === "harmonic" ? "Гармоническая фигура" : "Фазовый портрет");
  const pointCount = Math.min(x.length, y.length);
  const visibleLayers = layers.filter(
    (layer) => Math.min(layer.x.length, layer.y.length) >= 2,
  );
  const mainTraceCount = pointCount >= 2 ? 1 : 0;
  const signalLayerCount = visibleLayers.filter(
    (layer) => layer.pitchClass === undefined,
  ).length;
  const noteLayers = visibleLayers.filter(
    (layer) => layer.pitchClass !== undefined,
  );
  const signalTraceCount = mainTraceCount + signalLayerCount;
  const noteTraceCount = noteLayers.length;
  const traceCount = signalTraceCount + noteTraceCount;
  const phaseDensity = phaseDensityResponse(
    traceCount,
    resolvedPhaseDetail,
    clamp(persistence, 0, 0.965),
    mode,
  );
  const resolvedPhaseSourceMode =
    phaseSourceMode ??
    (signalTraceCount > 0 && noteTraceCount > 0
      ? "hybrid"
      : signalTraceCount > 0
        ? "signal"
        : "notes");
  const phasePitches = noteLayers
    .map((layer) => layer.pitchClass)
    .filter((pitchClass): pitchClass is number => pitchClass !== undefined)
    .sort((left, right) => left - right)
    .join(",");
  const spatialTraceKeys = [
    ...(mainTraceCount > 0 ? ["main"] : []),
    ...layers.flatMap((layer, index) =>
      Math.min(layer.x.length, layer.y.length) >= 2
        ? [spatialLayerKey(layer, index)]
        : [],
    ),
  ];
  const spatialAxisSignatures = spatialTraceKeys.map((key) =>
    spatialAxisSignature(
      stableSpatialAxis(key, resolvedPhaseAxisDiversity),
    ),
  );
  const spatialTravelAxisSignatures = spatialTraceKeys.map((key) =>
    spatialAxisSignature(
      stableSpatialTravelAxis(key, resolvedPhaseAxisDiversity),
    ),
  );
  const uniqueSpatialTravelAxisCount = new Set(
    spatialTravelAxisSignatures,
  ).size;
  const spatialTravelPhases = spatialTraceKeys.map((key) =>
    stableSpatialTravelPhase(key).toFixed(3),
  );
  const uniqueSpatialAxisCount = new Set(spatialAxisSignatures).size;
  const diagnosticPhaseEnergy =
    resolvedPhaseEnergy ?? signalEnergy({ x, y, layers });
  const renderedMainPointCount = renderedPointCount(
    pointCount,
    resolvedPhaseDetail,
  );
  const maximumLayerPointCount = visibleLayers.reduce(
    (maximum, layer) =>
      Math.max(maximum, Math.min(layer.x.length, layer.y.length)),
    0,
  );
  const renderedMaximumLayerPointCount = renderedPointCount(
    maximumLayerPointCount,
    resolvedPhaseDetail,
  );
  const layerLabels = visibleLayers
    .map((layer) => layer.label)
    .filter((label): label is string => Boolean(label));
  const description =
    ariaLabel ??
    `${resolvedTitle}. Основная кривая построена по ${pointCount} парам отсчётов. Цветных слоёв: ${visibleLayers.length}${layerLabels.length > 0 ? ` (${layerLabels.join(", ")})` : ""}.`;

  const drawRef = useRef<() => void>(() => undefined);
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderData = smoothScopeData(
      dataRef.current,
      smoothingRef.current,
      optionsRef.current.speed,
      optionsRef.current.preset === "spatial",
    );
    paintScope(
      canvas,
      renderData,
      sizeRef.current,
      optionsRef.current,
      hardClearRef.current,
      spatialMotionRef.current,
    );
    hardClearRef.current = false;
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;

    const resize = () => {
      const bounds = viewport.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;

      const width = bounds.width;
      const height = bounds.height;
      const buffer = sceneBufferSize(width, height, window.devicePixelRatio || 1, quality);
      const dpr = buffer.ratio;
      const pixelWidth = buffer.width;
      const pixelHeight = buffer.height;

      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      sizeRef.current = { width, height, dpr };
      hardClearRef.current = true;
      drawRef.current();
    };

    resize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [quality]);

  useEffect(() => {
    const reducedMotion = motionIsReduced();
    const canSchedule =
      animate &&
      !reducedMotion &&
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function";

    if (
      !animate ||
      reducedMotion ||
      mode === "harmonic" ||
      (Math.min(x.length, y.length) < 2 && visibleLayers.length === 0)
    ) {
      hardClearRef.current = true;
    }

    if (!canSchedule) {
      drawRef.current();
      return;
    }

    const frame = window.requestAnimationFrame(() => drawRef.current());
    return () => window.cancelAnimationFrame(frame);
  }, [
    animate,
    autoGain,
    backgroundColor,
    color,
    gain,
    lineWidth,
    layers,
    mode,
    phaseGeometry,
    phaseBlur,
    phaseBrightness,
    phaseBend,
    phaseAxisDiversity,
    phaseDepth,
    phaseDetail,
    phaseEnergy,
    phaseGlow,
    phaseLineWidth,
    phaseLayerMotion,
    phaseLayerSoundResponse,
    phaseOpacity,
    phasePreset,
    phaseProjection,
    phaseRotation,
    phaseSpeed,
    phaseTilt,
    persistence,
    x,
    y,
  ]);

  return (
    <figure
      className={className}
      style={{
        display: "grid",
        gap: 10,
        minWidth: 0,
        margin: 0,
        ...style,
      }}
    >
      <figcaption
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          minWidth: 0,
        }}
      >
        <span id={titleId} style={{ color: "#f2f5ff", fontWeight: 650 }}>
          {resolvedTitle}
        </span>
        <span
          style={{
            color: color ?? (mode === "harmonic" ? "#a99cff" : "#75ead8"),
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.12em",
            whiteSpace: "nowrap",
          }}
        >
          {meta ?? (mode === "harmonic" ? "HARMONIC" : "LIVE")}
        </span>
      </figcaption>

      <div
        ref={viewportRef}
        className="lissajous-viewport"
        data-phase-renderer="lissajous"
        data-fractal-background={backgroundLayer ? "1" : "0"}
        style={{
          position: "relative",
          width: "100%",
          minWidth: 0,
          aspectRatio: "1 / 1",
          overflow: "hidden",
          border: "1px solid rgba(180, 199, 255, 0.12)",
          borderRadius: 16,
          background: backgroundColor,
          boxShadow: "inset 0 0 45px rgba(62, 82, 137, 0.09)",
        }}
      >
        {backgroundLayer && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 0,
              overflow: "hidden",
              pointerEvents: "none",
            }}
          >
            {backgroundLayer}
          </div>
        )}
        <canvas
          ref={canvasRef}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          data-phase-renderer="lissajous"
          data-phase-geometry={phaseGeometry}
          data-phase-mesh-source="same-trace-turns"
          data-phase-quality={quality}
          data-phase-path={mode === "harmonic" ? "closed" : "open"}
          data-phase-curve={
            phasePreset === "spatial"
              ? "spatial-cardinal"
              : mode === "phase" && resolvedPhaseDetail < 0.999
              ? "cardinal"
              : "polyline"
          }
          data-phase-preset={phasePreset}
          data-phase-projection={phaseProjection}
          data-phase-depth={resolvedPhaseDepth.toFixed(3)}
          data-phase-tilt={resolvedPhaseTilt.toFixed(3)}
          data-phase-rotation={resolvedPhaseRotation.toFixed(3)}
          data-phase-bend={resolvedPhaseBend.toFixed(3)}
          data-phase-axis-diversity={resolvedPhaseAxisDiversity.toFixed(3)}
          data-phase-layer-motion={resolvedPhaseLayerMotion.toFixed(3)}
          data-phase-layer-motion-model="independent-axis-travel"
          data-phase-layer-spin-origin="layer-center"
          data-phase-layer-travel-axes={spatialTravelAxisSignatures.join(";")}
          data-phase-layer-travel-phases={spatialTravelPhases.join(";")}
          data-phase-layer-travel-range={(
            Math.min(2, resolvedPhaseLayerMotion) *
            (0.12 + resolvedPhaseAxisDiversity * 0.1)
          ).toFixed(3)}
          data-phase-layer-base-velocity={(
            resolvedPhaseLayerMotion * 0.22
          ).toFixed(3)}
          data-phase-layer-sound-response={
            resolvedPhaseLayerSoundResponse.toFixed(3)
          }
          data-phase-axis-count={uniqueSpatialAxisCount}
          data-phase-travel-axis-count={uniqueSpatialTravelAxisCount}
          data-phase-layer-axes={spatialAxisSignatures.join(";")}
          data-phase-energy={diagnosticPhaseEnergy.toFixed(3)}
          data-fractal-background={backgroundLayer ? "1" : "0"}
          data-phase-source-mode={resolvedPhaseSourceMode}
          data-phase-trace-count={traceCount}
          data-phase-signal-count={signalTraceCount}
          data-phase-note-count={noteTraceCount}
          data-phase-pitches={phasePitches}
          data-phase-point-limit={MAX_RENDERED_POINTS}
          data-phase-detail={resolvedPhaseDetail.toFixed(3)}
          data-phase-speed={resolvedPhaseSpeed.toFixed(3)}
          data-phase-response-ms={phaseSmoothingTimeMs(
            resolvedPhaseSpeed,
          ).toFixed(0)}
          data-phase-opacity={resolvedPhaseOpacity.toFixed(3)}
          data-phase-brightness={resolvedPhaseBrightness.toFixed(3)}
          data-phase-line-width={resolvedPhaseLineWidth.toFixed(3)}
          data-phase-blur={resolvedPhaseBlur.toFixed(3)}
          data-phase-glow={resolvedPhaseGlow.toFixed(3)}
          data-phase-main-points={pointCount}
          data-phase-rendered-main-points={renderedMainPointCount}
          data-phase-max-layer-points={maximumLayerPointCount}
          data-phase-rendered-max-layer-points={
            renderedMaximumLayerPointCount
          }
          data-phase-persistence={clamp(persistence, 0, 0.965).toFixed(3)}
          data-phase-effective-persistence={phaseDensity.persistence.toFixed(3)}
          data-phase-glow-scale={phaseDensity.glowScale.toFixed(3)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            display: "block",
            width: "100%",
            height: "100%",
            opacity: resolvedPhaseOpacity,
            filter: [
              Math.abs(resolvedPhaseBrightness - 1) >= 0.001
                ? `brightness(${resolvedPhaseBrightness})`
                : "",
              resolvedPhaseBlur >= 0.001
                ? `blur(${resolvedPhaseBlur}px)`
                : "",
            ]
              .filter(Boolean)
              .join(" ") || "none",
          }}
        >
          {description}
        </canvas>
        <span id={descriptionId} style={visuallyHidden}>
          {description}
        </span>
      </div>
    </figure>
  );
}
