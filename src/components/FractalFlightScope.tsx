import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import {
  deriveFractalFlightParameters,
  findCyclicTraceOffset,
  morphTracePointsInPlace,
  projectGatePoint,
  resampleCyclicTraceInto,
  type FractalControlNote,
  type FractalFlightParameters,
  type GatePose,
} from "../visuals/fractalFlightModel";
import {
  advanceNewtonTravel,
  newtonCoefficients,
  NEWTON_DEEP_GLSL,
} from "../visuals/newtonNavigation";
import { sceneBufferSize, type SceneQuality } from "../visuals/phaseSurface";
import type { LissajousScopeLayer } from "./LissajousScope";

export type FractalTravelMode = "approach" | "recede" | "pulse";

export interface FractalFlightScopeProps {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  layers?: readonly LissajousScopeLayer[];
  notes?: readonly FractalControlNote[];
  /** Supply a new revision when reusing and mutating the same sample arrays. */
  frameId?: number | string;
  intensity?: number;
  title?: string;
  meta?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  animate?: boolean;
  backgroundColor?: string;
  /** Render only the animated fractal so another component can own the phase layer. */
  backgroundOnly?: boolean;
  /** Post-render brightness of the fractal layer. `1` is unchanged. */
  fractalBrightness?: number;
  /** Constant log-zoom offset added to the autonomous camera flight. */
  fractalZoomOffset?: number;
  /** Strength of continuous polynomial and coordinate deformation. */
  fractalMorph?: number;
  /** Amount by which the visible detail count grows and contracts over time. */
  fractalDetailMotion?: number;
  /** Base density of recursive bands and polar cells. */
  fractalDensity?: number;
  /** Strength and base sector count of the kaleidoscopic fold. */
  fractalSymmetry?: number;
  /** Multiplier for autonomous fractal animation. */
  fractalSpeed?: number;
  /** Camera travel direction. `pulse` preserves the original in/out flight. */
  fractalTravelMode?: FractalTravelMode;
  /** Strength of the sound-driven polynomial deformation and added camera rate. */
  fractalSoundResponse?: number;
  quality?: SceneQuality;
  /** Seconds for a sound change to settle to 95% of its new shape. */
  morphSeconds?: number;
}

interface TraceSnapshot {
  points: Float32Array<ArrayBuffer>;
  color: string;
  opacity: number;
  lineWidth: number;
}

interface MorphTrace extends TraceSnapshot {
  targetPoints: Float32Array<ArrayBuffer>;
  phaseOffset: number;
}

interface LivePhasePortrait {
  id: string;
  trace: MorphTrace;
  pitchClass: number | null;
  sourceRevision: number;
  shapeRevision: number;
}

interface PhaseTraceSource {
  id: string;
  snapshot: TraceSnapshot;
  pitchClass: number | null;
}

interface ScopeSize {
  width: number;
  height: number;
  overlayDpr: number;
}

interface FractalRenderer {
  render: (
    parameters: FractalFlightParameters,
    cameraTravel: number,
    cameraRotation: number,
    morphPhase: number,
    controls: FractalRenderControls,
  ) => void;
  dispose: () => void;
}

interface FractalRenderControls {
  brightness: number;
  morph: number;
  detailMotion: number;
  density: number;
  symmetry: number;
  soundResponse: number;
}

const MAX_TRACE_POINTS = 420;
const FRACTAL_MIN_LOG_ZOOM = 1.6;
const FRACTAL_SPAN = 1.86;
const FRACTAL_DETAIL_LENS = 0.58;
const FRACTAL_USER_ZOOM_RANGE = 1.25;
const TWO_PI = Math.PI * 2;

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

export const NEWTON_VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

export const NEWTON_FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 v_uv;
  uniform vec2 u_resolution;
  uniform vec2 u_julia;
  uniform vec2 u_coefficient_p;
  uniform vec2 u_coefficient_q;
  uniform float u_hue;
  uniform float u_warp;
  uniform float u_energy;
  uniform float u_travel;
  uniform float u_structure;
  uniform float u_rotation;
  uniform float u_morph_phase;
  uniform float u_morph_amount;
  uniform float u_detail_motion;
  uniform float u_density;
  uniform float u_symmetry;
  uniform float u_brightness;

  const float TAU = 6.28318530718;
  const float ITERATIONS = 72.0;
  const int MAX_ITER = 72;

  mat2 rotate2d(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, -s, s, c);
  }

  vec2 complexMultiply(vec2 left, vec2 right) {
    return vec2(
      left.x * right.x - left.y * right.y,
      left.x * right.y + left.y * right.x
    );
  }

  vec2 complexSquare(vec2 value) {
    return vec2(
      value.x * value.x - value.y * value.y,
      2.0 * value.x * value.y
    );
  }

  vec2 complexDivide(vec2 numerator, vec2 denominator) {
    float scale = max(dot(denominator, denominator), 0.0000000001);
    return vec2(
      numerator.x * denominator.x + numerator.y * denominator.y,
      numerator.y * denominator.x - numerator.x * denominator.y
    ) / scale;
  }

  vec2 complexSquareRoot(vec2 value) {
    float radius = length(value);
    float realPart = sqrt(max(0.0, 0.5 * (radius + value.x)));
    float imaginaryPart = sqrt(max(0.0, 0.5 * (radius - value.x)));
    return vec2(realPart, value.y < 0.0 ? -imaginaryPart : imaginaryPart);
  }

  vec2 polarFold(vec2 point, float sectors) {
    float radius = length(point);
    float sector = TAU / max(2.0, sectors);
    float angle = atan(point.y, point.x);
    angle = abs(mod(angle + sector * 0.5, sector) - sector * 0.5);
    return vec2(cos(angle), sin(angle)) * radius;
  }

  ${NEWTON_DEEP_GLSL}

  vec3 palette(float value) {
    vec3 offsets = vec3(0.02, 0.34, 0.67) + u_hue;
    return 0.5 + 0.5 * cos(TAU * (offsets + value));
  }

  // One continuously deformed Newton system for z³ + pz + q.
  // x: normalized convergence depth, y: final root angle,
  // z: converged flag, w: closest approach to a derivative pole.
  vec4 newtonField(vec2 local, float logZoom, vec2 focus, vec2 coefficientP, vec2 coefficientQ) {
    float skipped = 0.0;
    vec2 z = poleNewtonStart(local, logZoom, focus, coefficientP, coefficientQ, skipped);
    float iterationOffset = skipped - max(0.0, abs(logZoom) - 3.0) / 0.5849625007211562;
    float convergedAt = ITERATIONS;
    float converged = 0.0;
    float poleTrap = 10.0;

    for (int iteration = 0; iteration < MAX_ITER; iteration++) {
      if (dot(z, z) > 1048576.0) {
        float distantIterations = 0.0;
        z = renormalizeNewton(z, 0.0, coefficientP, coefficientQ, distantIterations);
        iterationOffset += distantIterations;
      }
      vec2 zSquared = complexSquare(z);
      vec2 polynomial =
        complexMultiply(zSquared, z) +
        complexMultiply(coefficientP, z) +
        coefficientQ;
      vec2 derivative = 3.0 * zSquared + coefficientP;
      float derivativeMagnitude = dot(derivative, derivative);
      poleTrap = min(poleTrap, sqrt(derivativeMagnitude));

      float residualSquared = dot(polynomial, polynomial);
      if (residualSquared < 0.000000000001) {
        // Newton converges quadratically at a simple root. Interpolate the
        // fractional last iteration so contours move instead of blinking.
        float fractionalIteration = log2(log(0.000000000001) / log(max(residualSquared, 1.0e-30)));
        convergedAt = max(0.0, float(iteration) + iterationOffset + fractionalIteration);
        converged = 1.0;
        break;
      }

      if (derivativeMagnitude < 0.0000000001) {
        z += vec2(0.000031, -0.000023);
      } else {
        z -= complexDivide(polynomial, derivative);
      }
    }

    float rootAngle = fract(atan(z.y, z.x) / TAU + 1.0);
    return vec4(
      clamp(convergedAt / ITERATIONS, 0.0, 1.0),
      rootAngle,
      converged,
      poleTrap
    );
  }

  vec3 shadeFractal(vec4 field, float detailCount) {
    float convergenceDepth = field.x;
    float boundary = pow(
      smoothstep(0.015, 0.40, convergenceDepth),
      0.88
    );
    float poleFilaments = pow(
      exp(
        -field.w /
          (0.09 + u_warp * 0.10 + u_energy * 0.04)
      ),
      1.12
    );
    float iterationBands =
      0.55 +
      0.45 * cos(
        convergenceDepth * ITERATIONS * (0.72 + u_structure * 0.22) +
        u_morph_phase * 0.12
      );
    float fineBands =
      0.55 +
      0.45 * cos(
        convergenceDepth * ITERATIONS * (0.52 + detailCount * 0.16) -
        field.y * TAU * detailCount +
        u_morph_phase * 0.21
      );
    vec3 basin = palette(field.y + u_structure * 0.1);
    vec3 boundaryInk = palette(
      field.y * 0.55 + convergenceDepth * 0.3 + u_structure * 0.24
    );
    vec3 colour = vec3(0.002, 0.004, 0.009);
    colour += basin *
      (
        0.025 +
        field.z * (1.0 - convergenceDepth) *
          (0.12 + iterationBands * 0.10)
      );
    colour += boundaryInk * mix(iterationBands, iterationBands * fineBands, u_density) * (
      boundary * (1.10 + u_energy * 0.35) +
      poleFilaments * (0.22 + u_warp * 0.18)
    );
    colour += basin * poleFilaments * boundary * 0.22;
    return colour;
  }

  void main() {
    vec2 uv = v_uv * 2.0 - 1.0;
    uv.x *= u_resolution.x / max(u_resolution.y, 1.0);

    float logZoom = u_travel;
    float radius = length(uv);
    float tonalAngle = u_hue * TAU;
    float morphAmount = clamp(u_morph_amount, 0.0, 1.0);
    float detailPulse =
      sin(u_morph_phase * 0.43 + sin(u_morph_phase * 0.17) * 1.7);
    float detailCount = clamp(
      mix(2.8, 10.5, u_density) +
        detailPulse * u_detail_motion * mix(1.5, 4.8, u_density),
      2.0,
      15.0
    );

    // Notes continuously move the coefficients of the same cubic polynomial.
    // The focus follows a derivative pole, which belongs to the recursive
    // boundary of the Newton basins and therefore remains detailed at depth.
    vec2 coefficientP = u_coefficient_p;
    vec2 coefficientQ = u_coefficient_q;
    vec2 focus = complexSquareRoot(-coefficientP / 3.0);

    vec2 local = rotate2d(u_rotation) * uv;
    float breath = 1.0 +
      (0.035 + u_energy * 0.05 + morphAmount * 0.12) *
        sin(u_morph_phase * 0.73 + u_structure * TAU);
    float stretch = 1.0 + u_warp * 0.15 *
      sin(u_morph_phase * 0.41 + tonalAngle);
    local *= vec2(stretch, 1.0 / max(stretch, 0.7));
    float shear = (u_structure - 0.5) * 0.2 + u_warp * 0.065 *
      sin(u_morph_phase * 0.29 + tonalAngle);
    local.x += local.y * shear;
    float sectorPosition = clamp(
      mix(2.0, 10.0, u_symmetry) +
        detailPulse * u_detail_motion * (1.0 + u_symmetry * 3.0),
      2.0,
      14.0
    );
    float lowerSectors = floor(sectorPosition);
    float sectorBlend = smoothstep(0.18, 0.82, fract(sectorPosition));
    vec2 foldedLower = polarFold(local, lowerSectors);
    vec2 foldedUpper = polarFold(local, min(14.0, lowerSectors + 1.0));
    vec2 folded = mix(foldedLower, foldedUpper, sectorBlend);
    float foldAmount = smoothstep(0.03, 0.42, u_symmetry) *
      (0.3 + morphAmount * 0.62);
    local = mix(local, folded, foldAmount);

    float polarAngle = atan(local.y, local.x);
    float cellRipple =
      sin(polarAngle * detailCount + u_morph_phase * 0.67) *
      sin(length(local) * (4.0 + detailCount) - u_morph_phase * 0.39);
    local *= 1.0 + cellRipple * u_detail_motion *
      mix(0.025, 0.105, u_density);
    vec2 localSquare = complexSquare(local);
    float bend = (0.018 + u_warp * 0.055 + morphAmount * 0.075) *
      (0.64 + 0.36 * sin(u_morph_phase * 0.37));
    local += localSquare * bend / (1.0 + dot(local, local));

    // A smooth close-up lens keeps the recursive boundary dense behind the
    // phase portrait while retaining its larger context near the edges.
    float detailLens = mix(
      0.58,
      1.0,
      smoothstep(0.18, 1.18, length(local))
    );
    local *= detailLens;

    const float NEWTON_SPAN = 1.86;
    float localSpan = NEWTON_SPAN * breath;
    vec3 colour = shadeFractal(
      newtonField(local * localSpan, logZoom, focus, coefficientP, coefficientQ),
      detailCount
    );
    colour += palette(0.19) * exp(-radius * 1.65) * 0.008;
    colour *= 1.0 - 0.34 * smoothstep(0.72, 1.72, radius);

    colour = pow(max(colour, vec3(0.0)), vec3(0.82));
    colour *= clamp(u_brightness, 0.05, 3.0);
    gl_FragColor = vec4(colour, 1.0);
  }
`;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function effectiveFractalLogZoom(baseZoom: number, zoomOffset: number): number {
  return baseZoom + clamp(zoomOffset, -1, 1) * FRACTAL_USER_ZOOM_RANGE;
}

function mod12(value: number): number {
  return ((Math.round(value) % 12) + 12) % 12;
}

function finiteSample(samples: ArrayLike<number>, index: number): number {
  const value = samples[index];
  return Number.isFinite(value) ? value : 0;
}

function captureTrace(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  color: string,
  opacity = 0.9,
  lineWidth = 1,
): TraceSnapshot | null {
  const count = Math.min(x.length, y.length);
  if (count < 2) return null;

  const stride = Math.max(1, Math.ceil(count / MAX_TRACE_POINTS));
  const sampledCount = Math.ceil(count / stride);
  let meanX = 0;
  let meanY = 0;
  let actualCount = 0;

  for (let index = 0; index < count; index += stride) {
    meanX += finiteSample(x, index);
    meanY += finiteSample(y, index);
    actualCount += 1;
  }
  meanX /= Math.max(1, actualCount);
  meanY /= Math.max(1, actualCount);

  let peak = 0;
  for (let index = 0; index < count; index += stride) {
    peak = Math.max(
      peak,
      Math.abs(finiteSample(x, index) - meanX),
      Math.abs(finiteSample(y, index) - meanY),
    );
  }
  if (peak < 1e-5) return null;

  const points = new Float32Array(sampledCount * 2);
  let target = 0;
  for (let index = 0; index < count; index += stride) {
    points[target] = (finiteSample(x, index) - meanX) / peak;
    points[target + 1] = (finiteSample(y, index) - meanY) / peak;
    target += 2;
  }

  return {
    points,
    color,
    opacity: clamp(opacity, 0, 1),
    lineWidth: Math.max(0.5, lineWidth),
  };
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createFractalRenderer(
  canvas: HTMLCanvasElement,
): FractalRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;

  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    NEWTON_VERTEX_SHADER,
  );
  const fragmentHighPrecision = gl.getShaderPrecisionFormat(
    gl.FRAGMENT_SHADER,
    gl.HIGH_FLOAT,
  );
  const fragmentSource =
    fragmentHighPrecision && fragmentHighPrecision.precision > 0
      ? NEWTON_FRAGMENT_SHADER
      : NEWTON_FRAGMENT_SHADER.replace(
          "precision highp float;",
          "precision mediump float;",
        );
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );

  const position = gl.getAttribLocation(program, "a_position");
  const resolution = gl.getUniformLocation(program, "u_resolution");
  const julia = gl.getUniformLocation(program, "u_julia");
  const coefficientP = gl.getUniformLocation(program, "u_coefficient_p");
  const coefficientQ = gl.getUniformLocation(program, "u_coefficient_q");
  const hue = gl.getUniformLocation(program, "u_hue");
  const warp = gl.getUniformLocation(program, "u_warp");
  const energy = gl.getUniformLocation(program, "u_energy");
  const travel = gl.getUniformLocation(program, "u_travel");
  const structure = gl.getUniformLocation(program, "u_structure");
  const rotation = gl.getUniformLocation(program, "u_rotation");
  const morphPhase = gl.getUniformLocation(program, "u_morph_phase");
  const morphAmount = gl.getUniformLocation(program, "u_morph_amount");
  const detailMotion = gl.getUniformLocation(program, "u_detail_motion");
  const density = gl.getUniformLocation(program, "u_density");
  const symmetry = gl.getUniformLocation(program, "u_symmetry");
  const brightness = gl.getUniformLocation(program, "u_brightness");

  if (position < 0) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  return {
    render(
      parameters,
      cameraTravel,
      cameraRotation,
      currentMorphPhase,
      controls,
    ) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform2f(julia, parameters.cX, parameters.cY);
      const coefficients = newtonCoefficients(
        parameters,
        currentMorphPhase,
        controls.morph,
        controls.soundResponse,
      );
      gl.uniform2f(coefficientP, coefficients.p.x, coefficients.p.y);
      gl.uniform2f(coefficientQ, coefficients.q.x, coefficients.q.y);
      gl.uniform1f(hue, parameters.hue / 360);
      gl.uniform1f(warp, parameters.warp);
      gl.uniform1f(energy, parameters.energy);
      gl.uniform1f(travel, cameraTravel);
      gl.uniform1f(structure, parameters.family);
      gl.uniform1f(rotation, cameraRotation);
      gl.uniform1f(morphPhase, currentMorphPhase);
      gl.uniform1f(morphAmount, controls.morph);
      gl.uniform1f(detailMotion, controls.detailMotion);
      gl.uniform1f(density, controls.density);
      gl.uniform1f(symmetry, controls.symmetry);
      gl.uniform1f(brightness, controls.brightness);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

function mixParameters(
  current: FractalFlightParameters,
  target: FractalFlightParameters,
  amount: number,
): FractalFlightParameters {
  const structuralTarget = target.noteCount > 0 ? target : current;
  const hueDelta =
    ((structuralTarget.hue - current.hue + 540) % 360) - 180;
  return {
    cX: current.cX + (structuralTarget.cX - current.cX) * amount,
    cY: current.cY + (structuralTarget.cY - current.cY) * amount,
    hue: (current.hue + hueDelta * amount + 360) % 360,
    warp:
      current.warp + (structuralTarget.warp - current.warp) * amount,
    speed: current.speed + (target.speed - current.speed) * amount,
    energy: current.energy + (target.energy - current.energy) * amount,
    noteCount: target.noteCount,
    family:
      current.family +
      (structuralTarget.family - current.family) * amount,
    zoomDirection:
      current.zoomDirection +
      (structuralTarget.zoomDirection - current.zoomDirection) * amount,
  };
}

function drawFallbackBackground(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  elapsedSeconds: number,
  parameters: FractalFlightParameters,
  brightness: number,
) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.filter = `brightness(${brightness})`;
  const gradient = context.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, `hsla(${parameters.hue}, 70%, 15%, 1)`);
  gradient.addColorStop(
    0.48,
    `hsla(${(parameters.hue + 80) % 360}, 60%, 7%, 1)`,
  );
  gradient.addColorStop(1, "#03050a");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const radius = Math.min(width, height) * 0.48;
  context.translate(width / 2, height / 2);
  context.rotate(elapsedSeconds * 0.025);
  context.strokeStyle = `hsla(${parameters.hue}, 75%, 65%, 0.11)`;
  context.lineWidth = 0.7;
  for (let ring = 0; ring < 18; ring += 1) {
    const phase = (ring / 18 + elapsedSeconds * 0.025 * parameters.speed) % 1;
    const scale = phase * phase;
    context.beginPath();
    for (let side = 0; side <= 7; side += 1) {
      const angle = (side / 7) * TWO_PI + ring * parameters.warp * 0.12;
      const modulation = 0.72 + 0.28 * Math.sin(angle * 3 + ring);
      const x = Math.cos(angle) * radius * scale * modulation;
      const y = Math.sin(angle) * radius * scale * modulation;
      if (side === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
  context.restore();
}

function drawProjectedTrace(
  context: CanvasRenderingContext2D,
  trace: TraceSnapshot,
  pose: GatePose,
  width: number,
  height: number,
  opacity: number,
  glow: number,
) {
  if (trace.points.length < 4 || opacity <= 0) return;

  const cosRoll = Math.cos(pose.roll);
  const sinRoll = Math.sin(pose.roll);
  const cosPitch = Math.cos(pose.pitch);
  const sinPitch = Math.sin(pose.pitch);
  const cosYaw = Math.cos(pose.yaw);
  const sinYaw = Math.sin(pose.yaw);
  const focalLength = Math.min(width, height) * 0.9;

  context.beginPath();
  let hasPoint = false;
  let hasDrawablePoint = false;
  let previousX = 0;
  let previousY = 0;
  const overscanX = width * 0.35;
  const overscanY = height * 0.35;
  const maximumSegmentLength = Math.min(width, height) * 0.42;
  for (let index = 0; index < trace.points.length; index += 2) {
    const localX = trace.points[index] * pose.scale;
    const localY = trace.points[index + 1] * pose.scale;
    const rolledX = localX * cosRoll - localY * sinRoll;
    const rolledY = localX * sinRoll + localY * cosRoll;
    const pitchedY = rolledY * cosPitch;
    const pitchedZ = rolledY * sinPitch;
    const rotatedX = rolledX * cosYaw + pitchedZ * sinYaw;
    const rotatedZ = -rolledX * sinYaw + pitchedZ * cosYaw;
    const depth = pose.depth + rotatedZ;
    if (depth <= 0.05) {
      hasPoint = false;
      continue;
    }
    const x = width / 2 + (focalLength * (pose.offsetX + rotatedX)) / depth;
    const y = height / 2 - (focalLength * (pose.offsetY + pitchedY)) / depth;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < -overscanX ||
      x > width + overscanX ||
      y < -overscanY ||
      y > height + overscanY
    ) {
      hasPoint = false;
      continue;
    }
    if (!hasPoint) {
      context.moveTo(x, y);
      hasPoint = true;
      hasDrawablePoint = true;
    } else if (
      Math.hypot(x - previousX, y - previousY) > maximumSegmentLength
    ) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
    previousX = x;
    previousY = y;
  }
  if (!hasDrawablePoint) return;

  context.save();
  context.globalCompositeOperation = "lighter";
  context.strokeStyle = trace.color;
  context.globalAlpha = opacity * trace.opacity * 0.11;
  context.lineWidth = trace.lineWidth + 0.8;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = trace.color;
  context.shadowBlur = Math.min(6, glow * 0.45);
  context.stroke();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = opacity * trace.opacity * 0.96;
  context.lineWidth = Math.max(0.55, trace.lineWidth * 0.9);
  context.shadowBlur = 0;
  context.stroke();
  context.restore();
}

function capturePhaseSources(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  layers: readonly LissajousScopeLayer[],
): PhaseTraceSource[] {
  const sources = new Map<string, PhaseTraceSource>();
  const directSignal = captureTrace(
    x,
    y,
    "#9ab3c7",
    layers.length > 0 ? 0.15 : 0.88,
    layers.length > 0 ? 0.65 : 1,
  );
  if (directSignal) {
    sources.set("signal", {
      id: "signal",
      snapshot: directSignal,
      pitchClass: null,
    });
  }

  layers.forEach((layer) => {
    const pitchClass =
      layer.pitchClass === undefined ? null : mod12(layer.pitchClass);
    const id = pitchClass === null ? "signal" : `note:${pitchClass}`;
    const snapshot = captureTrace(
      layer.x,
      layer.y,
      layer.color,
      layer.opacity ?? 0.9,
      clamp(layer.lineWidth ?? 0.95, 0.55, 1.25),
    );
    if (!snapshot) return;
    sources.set(id, { id, snapshot, pitchClass });
  });

  return [...sources.values()];
}

function createMorphTrace(snapshot: TraceSnapshot): MorphTrace {
  return {
    ...snapshot,
    targetPoints: snapshot.points.slice(),
    phaseOffset: Number.NaN,
  };
}

export function FractalFlightScope({
  x,
  y,
  layers = [],
  notes = [],
  frameId,
  intensity = 0,
  title = "Фрактальный полёт",
  meta = "FLIGHT β",
  ariaLabel,
  className,
  style,
  animate = true,
  backgroundColor = "#03050a",
  backgroundOnly = false,
  fractalBrightness = 1,
  fractalZoomOffset = 0,
  fractalMorph = 0.8,
  fractalDetailMotion = 0.75,
  fractalDensity = 0.65,
  fractalSymmetry = 0.7,
  fractalSpeed = 1,
  fractalTravelMode = "approach",
  fractalSoundResponse = 1,
  quality = "auto",
  morphSeconds = 3,
}: FractalFlightScopeProps) {
  const resolvedFractalBrightness = clamp(fractalBrightness, 0.05, 3);
  const resolvedFractalZoomOffset = clamp(fractalZoomOffset, -1, 1);
  const resolvedFractalMorph = clamp(fractalMorph, 0, 1);
  const resolvedFractalDetailMotion = clamp(fractalDetailMotion, 0, 1);
  const resolvedFractalDensity = clamp(fractalDensity, 0, 1);
  const resolvedFractalSymmetry = clamp(fractalSymmetry, 0, 1);
  const resolvedFractalSpeed = clamp(fractalSpeed, 0, 2);
  const resolvedFractalSoundResponse = clamp(fractalSoundResponse, 0, 2);
  const viewportRef = useRef<HTMLDivElement>(null);
  const fractalCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef<ScopeSize>({ width: 0, height: 0, overlayDpr: 1 });
  const livePhasesRef = useRef(new Map<string, LivePhasePortrait>());
  const phaseOrderRef = useRef<string[]>([]);
  const reducedMotionRef = useRef(false);
  const requestDrawRef = useRef<() => void>(() => undefined);
  const titleId = useId();
  const descriptionId = useId();

  const targetParameters = useMemo(
    () => deriveFractalFlightParameters(notes, intensity),
    [intensity, notes],
  );
  const inputRef = useRef({
    x,
    y,
    layers,
    notes,
    targetParameters,
    backgroundOnly,
    fractalBrightness: resolvedFractalBrightness,
    fractalZoomOffset: resolvedFractalZoomOffset,
    fractalMorph: resolvedFractalMorph,
    fractalDetailMotion: resolvedFractalDetailMotion,
    fractalDensity: resolvedFractalDensity,
    fractalSymmetry: resolvedFractalSymmetry,
    fractalSpeed: resolvedFractalSpeed,
    fractalTravelMode,
    fractalSoundResponse: resolvedFractalSoundResponse,
    quality,
    morphSeconds: clamp(morphSeconds, 0.3, 12),
  });
  inputRef.current = {
    x,
    y,
    layers,
    notes,
    targetParameters,
    backgroundOnly,
    fractalBrightness: resolvedFractalBrightness,
    fractalZoomOffset: resolvedFractalZoomOffset,
    fractalMorph: resolvedFractalMorph,
    fractalDetailMotion: resolvedFractalDetailMotion,
    fractalDensity: resolvedFractalDensity,
    fractalSymmetry: resolvedFractalSymmetry,
    fractalSpeed: resolvedFractalSpeed,
    fractalTravelMode,
    fractalSoundResponse: resolvedFractalSoundResponse,
    quality,
    morphSeconds: clamp(morphSeconds, 0.3, 12),
  };

  useEffect(() => {
    if (backgroundOnly) {
      livePhasesRef.current.clear();
      phaseOrderRef.current = [];
      requestDrawRef.current();
      return;
    }
    const sources = capturePhaseSources(x, y, layers);
    const sourceIds = new Set(sources.map((source) => source.id));
    const portraits = livePhasesRef.current;

    for (const id of portraits.keys()) {
      if (!sourceIds.has(id)) portraits.delete(id);
    }

    for (const source of sources) {
      const portrait = portraits.get(source.id);
      if (!portrait) {
        portraits.set(source.id, {
          id: source.id,
          trace: createMorphTrace(source.snapshot),
          pitchClass: source.pitchClass,
          sourceRevision: 1,
          shapeRevision: 0,
        });
        continue;
      }

      portrait.trace.phaseOffset = findCyclicTraceOffset(
        portrait.trace.points,
        source.snapshot.points,
        portrait.trace.phaseOffset,
      );
      resampleCyclicTraceInto(
        portrait.trace.targetPoints,
        source.snapshot.points,
        portrait.trace.phaseOffset,
      );
      portrait.trace.color = source.snapshot.color;
      portrait.trace.opacity = source.snapshot.opacity;
      portrait.trace.lineWidth = source.snapshot.lineWidth;
      portrait.pitchClass = source.pitchClass;
      portrait.sourceRevision += 1;

      if (!animate || reducedMotionRef.current) {
        portrait.trace.points.set(portrait.trace.targetPoints);
        portrait.shapeRevision += 1;
      }
    }

    phaseOrderRef.current = sources.map((source) => source.id);
    requestDrawRef.current();
  }, [animate, backgroundOnly, frameId, layers, x, y]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const fractalCanvas = fractalCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!viewport || !fractalCanvas || !overlayCanvas) return;
    const viewportElement = viewport;
    const fractalCanvasElement = fractalCanvas;
    const overlayCanvasElement = overlayCanvas;

    let disposed = false;
    let renderer = createFractalRenderer(fractalCanvasElement);
    let animationFrame = 0;
    let lastTimestamp = 0;
    let visualTimeSeconds = 0;
    let smoothedParameters = inputRef.current.targetParameters;
    let activeTravelMode = inputRef.current.fractalTravelMode;
    let fractalTravelPhase = 0;
    let fractalTravelWave = 0;
    let fractalLogZoom =
      activeTravelMode === "recede" ? 4.72 : FRACTAL_MIN_LOG_ZOOM;
    let lastQuality = inputRef.current.quality;
    let fractalRotation = 0;
    let fractalMorphPhase = 0.8;
    let lastFractalTimestamp = -Infinity;
    let lastStillTimestamp = -Infinity;
    let inViewport = true;
    let documentVisible = document.visibilityState !== "hidden";
    const motionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    let reducedMotion = motionQuery?.matches ?? false;
    reducedMotionRef.current = reducedMotion;
    let actualZoomDirection: 1 | -1 =
      activeTravelMode === "recede" ? -1 : 1;
    let baseTravelRate = 0.2 * inputRef.current.fractalSpeed;
    let effectiveTravelRate =
      (0.2 +
        (smoothedParameters.speed * 0.34 + smoothedParameters.energy * 0.1) *
          inputRef.current.fractalSoundResponse) *
      inputRef.current.fractalSpeed;

    const overlayContext = overlayCanvasElement.getContext("2d");

    function resize() {
      const bounds = viewportElement.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const overlayDpr = clamp(window.devicePixelRatio || 1, 1, 2);
      const bufferSize = sceneBufferSize(
        bounds.width,
        bounds.height,
        window.devicePixelRatio || 1,
        inputRef.current.quality,
      );
      const fractalDpr = bufferSize.ratio;
      const overlayWidth = Math.max(1, Math.round(bounds.width * overlayDpr));
      const overlayHeight = Math.max(1, Math.round(bounds.height * overlayDpr));
      const fractalWidth = Math.max(1, Math.round(bounds.width * fractalDpr));
      const fractalHeight = Math.max(1, Math.round(bounds.height * fractalDpr));
      if (overlayCanvasElement.width !== overlayWidth) {
        overlayCanvasElement.width = overlayWidth;
      }
      if (overlayCanvasElement.height !== overlayHeight) {
        overlayCanvasElement.height = overlayHeight;
      }
      if (fractalCanvasElement.width !== fractalWidth) {
        fractalCanvasElement.width = fractalWidth;
      }
      if (fractalCanvasElement.height !== fractalHeight) {
        fractalCanvasElement.height = fractalHeight;
      }
      sizeRef.current = {
        width: bounds.width,
        height: bounds.height,
        overlayDpr,
      };
      lastFractalTimestamp = -Infinity;
      requestDraw();
    }

    function shouldAnimate() {
      return animate && !reducedMotion && inViewport && documentVisible;
    }

    function renderOverlay(elapsedSeconds: number) {
      const portraits = inputRef.current.backgroundOnly
        ? []
        : phaseOrderRef.current.flatMap((id) => {
            const portrait = livePhasesRef.current.get(id);
            return portrait ? [portrait] : [];
          });
      const hero =
        portraits
          .filter((portrait) => portrait.pitchClass !== null)
          .sort(
            (left, right) =>
              (left.pitchClass ?? 0) - (right.pitchClass ?? 0),
          )[0] ?? portraits[0];
      const signalCount = portraits.some((portrait) => portrait.id === "signal")
        ? 1
        : 0;
      const notePitches = portraits
        .flatMap((portrait) =>
          portrait.pitchClass === null ? [] : [portrait.pitchClass],
        )
        .sort((left, right) => left - right);
      const sourceMode =
        signalCount > 0 && notePitches.length > 0
          ? "hybrid"
          : signalCount > 0
            ? "signal"
            : "notes";
      const sourceRevision = portraits.reduce(
        (total, portrait) => total + portrait.sourceRevision,
        0,
      );
      const shapeRevision = portraits.reduce(
        (total, portrait) => total + portrait.shapeRevision,
        0,
      );
      const controls = inputRef.current;
      const coefficients = newtonCoefficients(
        smoothedParameters,
        fractalMorphPhase,
        controls.fractalMorph,
        controls.fractalSoundResponse,
      );
      const focus = coefficients.focus;
      const detailPulse = Math.sin(
        fractalMorphPhase * 0.43 +
          Math.sin(fractalMorphPhase * 0.17) * 1.7,
      );
      const detailCount = clamp(
        2.8 + controls.fractalDensity * 7.7 +
          detailPulse *
            controls.fractalDetailMotion *
            (1.5 + controls.fractalDensity * 3.3),
        2,
        15,
      );
      const sectorCount = clamp(
        2 + controls.fractalSymmetry * 8 +
          detailPulse *
            controls.fractalDetailMotion *
            (1 + controls.fractalSymmetry * 3),
        2,
        14,
      );
      const breath =
        1 +
        (0.035 +
          smoothedParameters.energy * 0.05 +
          controls.fractalMorph * 0.12) *
          Math.sin(
            fractalMorphPhase * 0.73 +
              smoothedParameters.family * TWO_PI,
          );
      const shear =
        (smoothedParameters.family - 0.5) * 0.18 +
        smoothedParameters.warp *
          0.055 *
          Math.sin(
            fractalMorphPhase * 0.29 +
              (smoothedParameters.hue / 360) * TWO_PI,
          );
      const effectiveLogZoom = effectiveFractalLogZoom(
        fractalLogZoom,
        inputRef.current.fractalZoomOffset,
      );

      viewportElement.dataset.phaseMode = "fixed-live";
      viewportElement.dataset.flightGates = "0";
      viewportElement.dataset.flightLiveGates = "0";
      viewportElement.dataset.flightEchoGates = "0";
      viewportElement.dataset.flightVisibleGates = "0";
      viewportElement.dataset.flightProminentGates = "0";
      viewportElement.dataset.flightHeroId = "";
      viewportElement.dataset.flightOpacitySum = "0.000";
      viewportElement.dataset.flightHistorySize = "0";
      viewportElement.dataset.flightMinDepthGap = "";
      viewportElement.dataset.flightGateStates = "[]";
      viewportElement.dataset.flightLatestPitch =
        hero?.pitchClass === null || hero?.pitchClass === undefined
          ? ""
          : String(hero.pitchClass);
      viewportElement.dataset.flightMorphRevision = String(shapeRevision);
      viewportElement.dataset.phaseSourceMode = sourceMode;
      viewportElement.dataset.phaseTraceCount = String(portraits.length);
      viewportElement.dataset.phaseSignalCount = String(signalCount);
      viewportElement.dataset.phaseNoteCount = String(notePitches.length);
      viewportElement.dataset.phasePitches = notePitches.join(",");
      viewportElement.dataset.phaseSourceStates = JSON.stringify(
        portraits.map((portrait) => ({
          id: portrait.id,
          sourceRevision: portrait.sourceRevision,
          shapeRevision: portrait.shapeRevision,
        })),
      );
      viewportElement.dataset.fixedPhaseCount = String(portraits.length);
      viewportElement.dataset.fixedPhaseVisible = portraits.length > 0 ? "1" : "0";
      viewportElement.dataset.fixedPhasePitch =
        hero?.pitchClass === null || hero?.pitchClass === undefined
          ? ""
          : String(hero.pitchClass);
      viewportElement.dataset.fixedPhaseSourceRevision = String(sourceRevision);
      viewportElement.dataset.fixedPhaseShapeRevision = String(shapeRevision);
      viewportElement.dataset.fixedPhaseSourceActive =
        portraits.length > 0 ? "1" : "0";
      viewportElement.dataset.fixedPhaseColor = hero?.trace.color ?? "";
      viewportElement.dataset.fixedPhaseDepth = "2.550";
      viewportElement.dataset.fixedPhasePose = "stationary";
      viewportElement.dataset.fixedPhaseTransform =
        "0,0,0,0,0,2.550,1.040";
      viewportElement.dataset.fixedPhaseMotion = "live";

      viewportElement.dataset.fractalVariant = "continuous-newton-flow";
      viewportElement.dataset.fractalDetailMode = "pole-renormalized-newton";
      viewportElement.dataset.fractalCameraModel = "unbounded-log2";
      viewportElement.dataset.fractalCoefficientP = `${coefficients.p.x.toFixed(6)},${coefficients.p.y.toFixed(6)}`;
      viewportElement.dataset.fractalCoefficientQ = `${coefficients.q.x.toFixed(6)},${coefficients.q.y.toFixed(6)}`;
      viewportElement.dataset.fractalMorphSeconds =
        controls.morphSeconds.toFixed(2);
      viewportElement.dataset.fractalQuality = controls.quality;
      viewportElement.dataset.fractalShaderStatus = renderer
        ? "ready"
        : "fallback";
      viewportElement.dataset.fractalMinLogZoom = "unbounded";
      viewportElement.dataset.fractalMaxLogZoom = "unbounded";
      viewportElement.dataset.fractalTravelWave = fractalTravelWave.toFixed(4);
      viewportElement.dataset.fractalStructure =
        smoothedParameters.family.toFixed(3);
      viewportElement.dataset.fractalFamily =
        smoothedParameters.family.toFixed(3);
      viewportElement.dataset.fractalPower = "3";
      viewportElement.dataset.fractalIterations = "72";
      viewportElement.dataset.fractalBrightness =
        inputRef.current.fractalBrightness.toFixed(3);
      viewportElement.dataset.fractalZoomOffset =
        inputRef.current.fractalZoomOffset.toFixed(3);
      viewportElement.dataset.fractalMorphAmount =
        controls.fractalMorph.toFixed(3);
      viewportElement.dataset.fractalDetailMotion =
        controls.fractalDetailMotion.toFixed(3);
      viewportElement.dataset.fractalDensity =
        controls.fractalDensity.toFixed(3);
      viewportElement.dataset.fractalSymmetry =
        controls.fractalSymmetry.toFixed(3);
      viewportElement.dataset.fractalSpeed =
        controls.fractalSpeed.toFixed(3);
      viewportElement.dataset.fractalTravelMode = controls.fractalTravelMode;
      viewportElement.dataset.fractalSoundResponse =
        controls.fractalSoundResponse.toFixed(3);
      viewportElement.dataset.fractalBaseTravelRate =
        baseTravelRate.toFixed(4);
      viewportElement.dataset.fractalEffectiveTravelRate =
        effectiveTravelRate.toFixed(4);
      viewportElement.dataset.fractalDetailCount = detailCount.toFixed(3);
      viewportElement.dataset.fractalSectorCount = sectorCount.toFixed(3);
      viewportElement.dataset.fractalBaseLogZoom = fractalLogZoom.toFixed(3);
      viewportElement.dataset.fractalLogZoom = effectiveLogZoom.toFixed(3);
      viewportElement.dataset.fractalLevel = String(
        Math.floor(effectiveLogZoom),
      );
      viewportElement.dataset.fractalLocalScale = (
        (FRACTAL_SPAN * FRACTAL_DETAIL_LENS) / 2 ** effectiveLogZoom
      ).toExponential(3);
      viewportElement.dataset.fractalFocusX = focus.x.toFixed(4);
      viewportElement.dataset.fractalFocusY = focus.y.toFixed(4);
      viewportElement.dataset.fractalActualDirection =
        String(actualZoomDirection);
      viewportElement.dataset.fractalRotation = fractalRotation.toFixed(5);
      viewportElement.dataset.fractalRotationDirection = "1";
      viewportElement.dataset.fractalMorph =
        fractalMorphPhase.toFixed(5);
      viewportElement.dataset.fractalShear = shear.toFixed(4);
      viewportElement.dataset.fractalBreath = breath.toFixed(4);

      if (!overlayContext) return;
      const { width, height, overlayDpr } = sizeRef.current;
      if (width <= 0 || height <= 0) return;
      overlayContext.setTransform(overlayDpr, 0, 0, overlayDpr, 0, 0);
      overlayContext.clearRect(0, 0, width, height);

      if (!renderer) {
        drawFallbackBackground(
          overlayContext,
          width,
          height,
          elapsedSeconds,
          smoothedParameters,
          inputRef.current.fractalBrightness,
        );
      }

      if (!inputRef.current.backgroundOnly) {
        for (const portrait of portraits) {
          drawProjectedTrace(
            overlayContext,
            portrait.trace,
            {
              depth: 2.55,
              offsetX: 0,
              offsetY: 0,
              yaw: 0,
              pitch: 0,
              roll: 0,
              scale: 1.04,
            },
            width,
            height,
            0.9,
            3,
          );
        }

        const centre = projectGatePoint(
          0,
          0,
          {
            depth: 2.55,
            offsetX: 0,
            offsetY: 0,
            yaw: 0,
            pitch: 0,
            roll: 0,
            scale: 1,
          },
          width,
          height,
        );
        overlayContext.save();
        overlayContext.globalCompositeOperation = "lighter";
        overlayContext.fillStyle = "rgba(214, 255, 250, 0.82)";
        overlayContext.shadowColor = "#75f5e4";
        overlayContext.shadowBlur = 9;
        overlayContext.beginPath();
        overlayContext.arc(centre.x, centre.y, 1.5, 0, TWO_PI);
        overlayContext.fill();
        overlayContext.restore();
      }
    }

    function render(timestamp: number, advance: boolean, forceFractal = false) {
      if (disposed) return;
      const deltaSeconds =
        lastTimestamp === 0
          ? 0
          : clamp((timestamp - lastTimestamp) / 1_000, 0, 0.05);
      lastTimestamp = timestamp;
      if (advance) visualTimeSeconds += deltaSeconds;
      const elapsedSeconds = visualTimeSeconds;

      const target = inputRef.current.targetParameters;
      const smoothing =
        !animate || reducedMotion
          ? 1
          : 1 -
            Math.exp(
              (-Math.max(deltaSeconds, 1 / 120) * 3) /
                inputRef.current.morphSeconds,
            );
      if (lastQuality !== inputRef.current.quality) {
        lastQuality = inputRef.current.quality;
        resize();
      }
      smoothedParameters = mixParameters(smoothedParameters, target, smoothing);
      const requestedTravelMode = inputRef.current.fractalTravelMode;
      if (requestedTravelMode !== activeTravelMode) {
        activeTravelMode = requestedTravelMode;
        actualZoomDirection = activeTravelMode === "recede" ? -1 : 1;
      }
      const animationSpeed = inputRef.current.fractalSpeed;
      baseTravelRate = 0.2 * animationSpeed;
      effectiveTravelRate =
        (0.2 +
          (smoothedParameters.speed * 0.34 +
            smoothedParameters.energy * 0.1) *
            inputRef.current.fractalSoundResponse) *
        animationSpeed;
      if (advance) {
        const travelState = advanceNewtonTravel(
          {
            logZoom: fractalLogZoom,
            phase: fractalTravelPhase,
            direction: actualZoomDirection,
          },
          activeTravelMode,
          deltaSeconds,
          effectiveTravelRate,
        );
        fractalLogZoom = travelState.logZoom;
        fractalTravelPhase = travelState.phase;
        fractalTravelWave = Math.sin(fractalTravelPhase);
        actualZoomDirection = travelState.direction;

        // Rotation is integrated on the CPU with a strictly positive
        // velocity, so changing notes cannot make it reverse or twitch.
        fractalRotation +=
          deltaSeconds *
          (0.026 + smoothedParameters.speed * 0.052) *
          animationSpeed;
        fractalMorphPhase +=
          deltaSeconds *
          (0.22 +
            smoothedParameters.speed * 0.46 +
            smoothedParameters.energy * 0.18) *
          animationSpeed;

        for (const portrait of livePhasesRef.current.values()) {
          if (
            morphTracePointsInPlace(
              portrait.trace.points,
              portrait.trace.targetPoints,
              1 - Math.exp(-deltaSeconds / 0.075),
            )
          ) {
            portrait.shapeRevision += 1;
          }
        }
      }

      if (
        renderer &&
        (forceFractal || timestamp - lastFractalTimestamp >= 32)
      ) {
        const effectiveLogZoom = effectiveFractalLogZoom(
          fractalLogZoom,
          inputRef.current.fractalZoomOffset,
        );
        renderer.render(
          smoothedParameters,
          effectiveLogZoom,
          fractalRotation,
          fractalMorphPhase,
          {
            brightness: inputRef.current.fractalBrightness,
            morph: inputRef.current.fractalMorph,
            detailMotion: inputRef.current.fractalDetailMotion,
            density: inputRef.current.fractalDensity,
            symmetry: inputRef.current.fractalSymmetry,
            soundResponse: inputRef.current.fractalSoundResponse,
          },
        );
        viewportElement.dataset.fractalTravel = effectiveLogZoom.toFixed(3);
        lastFractalTimestamp = timestamp;
      }
      renderOverlay(elapsedSeconds);
    }

    function tick(timestamp: number) {
      animationFrame = 0;
      if (!shouldAnimate()) return;
      render(timestamp, true);
      animationFrame = window.requestAnimationFrame(tick);
    }

    function stillTick(timestamp: number) {
      animationFrame = 0;
      if (
        disposed ||
        !animate ||
        !reducedMotion ||
        !inViewport ||
        !documentVisible
      ) {
        return;
      }
      if (timestamp - lastStillTimestamp < 120) {
        animationFrame = window.requestAnimationFrame(stillTick);
        return;
      }
      lastStillTimestamp = timestamp;
      render(timestamp, false, true);
    }

    function requestDraw() {
      if (disposed || !inViewport || !documentVisible) return;
      if (!animate || typeof window.requestAnimationFrame !== "function") {
        render(
          typeof performance !== "undefined" ? performance.now() : 0,
          false,
          true,
        );
        return;
      }
      if (reducedMotion) {
        if (animationFrame === 0) {
          animationFrame = window.requestAnimationFrame(stillTick);
        }
        return;
      }
      if (animationFrame === 0) {
        animationFrame = window.requestAnimationFrame(tick);
      }
    }

    requestDrawRef.current = requestDraw;

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(resize);
    if (resizeObserver) resizeObserver.observe(viewportElement);
    else window.addEventListener("resize", resize);

    const intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            inViewport = entries[0]?.isIntersecting ?? true;
            lastTimestamp = 0;
            if (!inViewport && animationFrame !== 0) {
              window.cancelAnimationFrame(animationFrame);
              animationFrame = 0;
            }
            requestDraw();
          });
    if (intersectionObserver) intersectionObserver.observe(viewportElement);

    const handleVisibility = () => {
      documentVisible = document.visibilityState !== "hidden";
      lastTimestamp = 0;
      if (!documentVisible && animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      requestDraw();
    };
    const handleMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      reducedMotionRef.current = reducedMotion;
      if (reducedMotion) {
        for (const portrait of livePhasesRef.current.values()) {
          portrait.trace.points.set(portrait.trace.targetPoints);
          portrait.shapeRevision += 1;
        }
      }
      lastTimestamp = 0;
      if (animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
      requestDraw();
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      renderer = null;
      requestDraw();
    };
    const handleContextRestored = () => {
      renderer = createFractalRenderer(fractalCanvasElement);
      lastFractalTimestamp = -Infinity;
      requestDraw();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    motionQuery?.addEventListener("change", handleMotionChange);
    fractalCanvasElement.addEventListener(
      "webglcontextlost",
      handleContextLost,
    );
    fractalCanvasElement.addEventListener(
      "webglcontextrestored",
      handleContextRestored,
    );

    resize();
    requestDraw();

    return () => {
      disposed = true;
      reducedMotionRef.current = false;
      requestDrawRef.current = () => undefined;
      if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
      motionQuery?.removeEventListener("change", handleMotionChange);
      fractalCanvasElement.removeEventListener(
        "webglcontextlost",
        handleContextLost,
      );
      fractalCanvasElement.removeEventListener(
        "webglcontextrestored",
        handleContextRestored,
      );
      renderer?.dispose();
    };
  }, [animate]);

  useEffect(
    () => requestDrawRef.current(),
    [
      frameId,
      intensity,
      layers,
      notes,
      resolvedFractalBrightness,
      resolvedFractalDensity,
      resolvedFractalDetailMotion,
      resolvedFractalMorph,
      resolvedFractalSoundResponse,
      resolvedFractalSpeed,
      resolvedFractalSymmetry,
      resolvedFractalZoomOffset,
      fractalTravelMode,
      targetParameters,
      quality,
      morphSeconds,
    ],
  );

  const description =
    ariaLabel ??
    `${title}. Выбранные живые фазовые контуры непрерывно меняют форму в одной неподвижной плоскости; фрактал плавно меняет форму, число деталей, симметрию, масштаб и рисунок от распознанных нот и энергии сигнала.`;

  if (backgroundOnly) {
    return (
      <div
        ref={viewportRef}
        className={className}
        aria-hidden="true"
        data-fractal-backdrop="continuous-newton-flow"
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          background: backgroundColor,
          pointerEvents: "none",
          ...style,
        }}
      >
        <canvas
          ref={fractalCanvasRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "block",
            width: "100%",
            height: "100%",
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "block",
            width: "100%",
            height: "100%",
          }}
        />
      </div>
    );
  }

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
          {title}
        </span>
        <span
          style={{
            color: "#75ead8",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.12em",
            whiteSpace: "nowrap",
          }}
        >
          {meta}
        </span>
      </figcaption>

      <div
        ref={viewportRef}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        style={{
          position: "relative",
          width: "100%",
          minWidth: 0,
          aspectRatio: "1 / 1",
          overflow: "hidden",
          border: "1px solid rgba(180, 199, 255, 0.12)",
          borderRadius: 16,
          background: backgroundColor,
          boxShadow: "inset 0 0 55px rgba(62, 150, 153, 0.11)",
        }}
      >
        <canvas
          ref={fractalCanvasRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "block",
            width: "100%",
            height: "100%",
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "block",
            width: "100%",
            height: "100%",
          }}
        />
        <span id={descriptionId} style={visuallyHidden}>
          {description}
        </span>
      </div>
    </figure>
  );
}
