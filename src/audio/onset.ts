import type { DetectedNote } from "../domain/music";
import type { MonophonicPitch } from "./dsp";

export interface StreamingOnsetConfig {
  waitFrames: number;
  minimumGapMs: number;
  initialFluxFloor: number;
  absoluteFluxThreshold: number;
  fluxFloorMultiplier: number;
  strongFluxMultiplier: number;
  minimumStrongFluxRmsRatio: number;
  absoluteReleaseRmsDrop: number;
  fluxFloorDecay: number;
  maximumFluxFloorContribution: number;
  rmsRiseRatio: number;
  rmsRiseBias: number;
  absoluteRmsRise: number;
  onsetMinConfidence: number;
  acceptedNoteConfidence: number;
}

export const DEFAULT_STREAMING_ONSET_CONFIG: StreamingOnsetConfig = {
  waitFrames: 2,
  minimumGapMs: 120,
  initialFluxFloor: 0.02,
  absoluteFluxThreshold: 0.045,
  fluxFloorMultiplier: 2.7,
  strongFluxMultiplier: 1.65,
  // Normalized flux can spike while a note is disappearing because the
  // denominator shrinks. Treat it as a release only when both the relative
  // and absolute RMS drops are material, preserving quiet added strings.
  minimumStrongFluxRmsRatio: 0.9,
  absoluteReleaseRmsDrop: 0.004,
  fluxFloorDecay: 0.94,
  maximumFluxFloorContribution: 0.12,
  rmsRiseRatio: 1.1,
  rmsRiseBias: 0.0007,
  absoluteRmsRise: 0.004,
  onsetMinConfidence: 0.18,
  acceptedNoteConfidence: 0.28,
};

export interface OnsetTriggerInput {
  flux: number;
  threshold: number;
  rms: number;
  previousRms: number;
  elapsedSinceLastOnsetMs: number;
}

export function shouldStartOnset(
  input: OnsetTriggerInput,
  config: StreamingOnsetConfig = DEFAULT_STREAMING_ONSET_CONFIG,
): boolean {
  const rmsRise =
    input.rms > input.previousRms * config.rmsRiseRatio + config.rmsRiseBias ||
    input.rms - input.previousRms > config.absoluteRmsRise;
  const sharpRelease =
    input.previousRms > 0 &&
    input.rms < input.previousRms * config.minimumStrongFluxRmsRatio &&
    input.previousRms - input.rms > config.absoluteReleaseRmsDrop;
  const strongFluxWithoutRelease =
    input.flux > input.threshold * config.strongFluxMultiplier && !sharpRelease;
  return (
    input.elapsedSinceLastOnsetMs >= config.minimumGapMs &&
    input.flux > input.threshold &&
    (rmsRise || strongFluxWithoutRelease)
  );
}

export function selectOnsetNote(
  spectralNote: DetectedNote | undefined,
  monophonic: MonophonicPitch | null,
  hadHeldNotes: boolean,
): DetectedNote | undefined {
  const clearMonophonic =
    monophonic && monophonic.clarity >= 0.76 ? monophonic.note : undefined;

  if (clearMonophonic && spectralNote?.pitchClass === clearMonophonic.pitchClass) {
    return {
      ...clearMonophonic,
      confidence: Math.max(clearMonophonic.confidence, spectralNote.confidence),
    };
  }

  // Full-waveform YIN can lock to an already sustained fundamental or a
  // combination pitch. Once a voicing is sounding, only the onset delta may
  // introduce a different pitch class.
  if (hadHeldNotes) return spectralNote;
  return clearMonophonic ?? spectralNote;
}
