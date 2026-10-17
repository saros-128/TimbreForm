import { LissajousScope, type LissajousScopeProps } from "./LissajousScope";
import type { SceneQuality } from "../visuals/phaseSurface";
import "./PhaseSceneScope.css";
export type PhaseGeometry = "lines" | "cage" | "surface";
export interface PhaseSceneProps extends LissajousScopeProps {
  geometry: PhaseGeometry;
  frameId?: number;
  quality: SceneQuality;
}
/** All three views share the original signal, smoothing, projection and strokes. */
export function PhaseSceneScope({
  geometry,
  quality,
  ...props
}: PhaseSceneProps) {
  return (
    <LissajousScope {...props} phaseGeometry={geometry} quality={quality} />
  );
}
