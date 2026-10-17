import type { FractalFlightParameters } from "./fractalFlightModel";

export type NewtonTravelMode = "approach" | "recede" | "pulse";
export interface NewtonTravel {
  logZoom: number;
  phase: number;
  direction: 1 | -1;
}
/** Signed log2 magnification is integrated, never wrapped or clamped. */
export function advanceNewtonTravel(
  state: NewtonTravel,
  mode: NewtonTravelMode,
  seconds: number,
  rate: number,
): NewtonTravel {
  const dt = Math.max(0, Math.min(0.1, Number.isFinite(seconds) ? seconds : 0));
  const speed = Math.max(0, Number.isFinite(rate) ? rate : 0);
  const phase = state.phase + dt * speed * 0.35;
  const delta =
    mode === "pulse"
      ? (Math.sin(phase) - Math.sin(state.phase)) / 0.35
      : dt * speed * (mode === "recede" ? -1 : 1);
  return {
    logZoom: state.logZoom + delta,
    phase,
    direction:
      mode === "recede"
        ? -1
        : mode === "approach"
          ? 1
          : Math.cos(phase) >= 0
            ? 1
            : -1,
  };
}

export interface Complex {
  x: number;
  y: number;
}
export function newtonCoefficients(
  parameters: FractalFlightParameters,
  phase: number,
  morph: number,
  response: number,
): { p: Complex; q: Complex; focus: Complex } {
  const sound = Math.max(0, Math.min(2, response)) * 0.65;
  const angle = (parameters.hue * Math.PI) / 180;
  const p = {
    x:
      -0.65 +
      ((parameters.family - 0.5) * 0.6 + parameters.cX * 0.16) * sound +
      Math.sin(phase * 0.19) * morph * 0.08,
    y:
      (parameters.cY * 0.38 + Math.sin(angle) * 0.1) * sound +
      Math.cos(phase * 0.31) * morph * 0.07,
  };
  const q = {
    x:
      0.28 +
      parameters.cX * 0.38 * sound +
      Math.cos(phase * 0.17) * morph * 0.09,
    y:
      (parameters.cY * 0.4 +
        Math.sin(angle) * (0.15 + parameters.energy * 0.1)) *
        sound +
      Math.sin(phase * 0.11) * morph * 0.08,
  };
  const rx = -p.x / 3,
    ry = -p.y / 3,
    radius = Math.hypot(rx, ry);
  const focus = {
    x: Math.sqrt(Math.max(0, (radius + rx) / 2)),
    y: (ry < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (radius - rx) / 2)),
  };
  return { p, q, focus };
}

// N(z) = (2z³ − q)/(3z² + p). At infinity N(z) ~ 2z/3.
// H(N(z)) = (2/3)H(z), with H(z)=z+h1/z+h2/z²+h3/z³+O(z^-4).
// This local conjugacy lets the shader skip distant iterations without moving
// the camera or losing a subpixel delta by adding it to the derivative pole.
export const NEWTON_LOG_STEP = Math.log2(1.5);
export const NEWTON_REDUCTION_LOG_RADIUS = 6;
export const NEWTON_DEEP_GLSL = `
  const float NEWTON_LOG_STEP = 0.5849625007211562;
  vec2 reciprocal(vec2 z) { return complexDivide(vec2(1.0, 0.0), z); }

  vec2 renormalizeNewton(vec2 mantissa, float exponent, vec2 p, vec2 q, out float skipped) {
    float logMagnitude = log2(max(length(mantissa), 0.000000000001)) + exponent;
    skipped = max(0.0, floor((logMagnitude - 6.0) / NEWTON_LOG_STEP));
    float remainingExponent = exponent - skipped * NEWTON_LOG_STEP;
    vec2 scaled = mantissa * exp2(remainingExponent);
    if (skipped < 0.5) return scaled;
    vec2 h1 = p * (4.0 / 15.0);
    vec2 h2 = q * (4.0 / 19.0);
    vec2 h3 = complexSquare(p) * (-224.0 / 2925.0);
    vec2 inverseOriginal = reciprocal(mantissa) * exp2(-min(exponent, 120.0));
    vec2 inverseOriginal2 = complexSquare(inverseOriginal);
    float scale = exp2(-min(skipped * NEWTON_LOG_STEP, 120.0));
    // Forward H before scaling; retain the correction when it is measurable.
    vec2 w = scaled + scale * (complexMultiply(h1, inverseOriginal) + complexMultiply(h2, inverseOriginal2) + complexMultiply(h3, complexMultiply(inverseOriginal2, inverseOriginal)));
    vec2 inverseW = reciprocal(w);
    vec2 inverseW2 = complexSquare(inverseW);
    // Inverse H at |w| >= 64. O(|w|^-4) is below highp float resolution.
    return w - complexMultiply(h1, inverseW) - complexMultiply(h2, inverseW2) - complexMultiply(h3 + complexSquare(h1), complexMultiply(inverseW2, inverseW));
  }

  vec2 poleNewtonStart(vec2 local, float logZoom, vec2 focus, vec2 p, vec2 q, out float skipped) {
    if (logZoom < 0.0) {
      vec2 mantissa = local + focus * exp2(max(logZoom, -120.0));
      return renormalizeNewton(mantissa, -logZoom, p, q, skipped);
    }
    // Evaluate N(focus + delta) by its factored polynomial. Computing
    // focus + delta directly would erase delta at roughly zoom 2^24.
    vec2 delta = local * exp2(-min(logZoom, 120.0));
    vec2 focus2 = complexSquare(focus);
    vec2 delta2 = complexSquare(delta);
    vec2 numerator = 2.0 * complexMultiply(focus2, focus) - q +
      6.0 * complexMultiply(focus2, delta) +
      6.0 * complexMultiply(focus, delta2) +
      2.0 * complexMultiply(delta2, delta);
    vec2 factor = complexDivide(numerator, 6.0 * focus + 3.0 * delta);
    vec2 mantissa = complexDivide(factor, local);
    vec2 z = renormalizeNewton(mantissa, logZoom, p, q, skipped);
    skipped += 1.0;
    return z;
  }
`;
