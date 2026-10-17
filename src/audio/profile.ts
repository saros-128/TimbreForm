import type { AnalysisFrame, AnalyzerConfig } from "./dsp";

export const LIVE_ANALYSIS_PROFILE = {
  fftSize: 8_192,
  smoothingTimeConstant: 0.12,
  analysisIntervalMs: 32,
} as const;

export type LiveAnalysisProfileId = "stable" | "responsive";

/**
 * Describes the acoustic path before analysis, independently of the selected
 * stable/responsive analyzer tuning. `clean` deliberately preserves the
 * original Web Audio and DSP path for DI/audio-interface inputs.
 */
export type AudioInputProfileId = "clean" | "microphone";

export const DEFAULT_AUDIO_INPUT_PROFILE: AudioInputProfileId = "clean";

export const MICROPHONE_INPUT_PROFILE = {
  highpassFrequencyHz: 52,
  highpassQ: Math.SQRT1_2,
  calibrationFrames: 28,
  openMarginDb: 8,
  closeMarginDb: 4,
  openSignalToNoiseDb: 12,
  closeSignalToNoiseDb: 8,
  releaseFrames: 4,
  activePeakDropDb: 16,
  activePeakRecoveryDb: 7,
  activePeakDecayPerFrameDb: 0.35,
} as const;

export interface RoomNoiseGateState {
  gated: boolean;
  calibrated: boolean;
  ambientRmsDb: number;
  openThresholdDb: number;
}

function amplitudeToDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1e-6));
}

function lowerQuartile(values: readonly number[]): number {
  if (values.length === 0) return -72;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * 0.25)];
}

/**
 * A conservative room-microphone gate. It learns the local RMS floor only
 * from frames that do not look like a musical signal, then opens above that
 * floor with separate open/close thresholds and a short release hold.
 */
export class AdaptiveRoomNoiseGate {
  private calibration: number[] = [];
  private ambientRmsDb = -72;
  private open = false;
  private releaseFramesRemaining = 0;
  private recentActivePeakRmsDb = -Infinity;
  private dropReleaseActive = false;

  reset(): void {
    this.calibration = [];
    this.ambientRmsDb = -72;
    this.open = false;
    this.releaseFramesRemaining = 0;
    this.recentActivePeakRmsDb = -Infinity;
    this.dropReleaseActive = false;
  }

  process(frame: AnalysisFrame): AnalysisFrame {
    const state = this.update(frame);
    if (!state.gated) return frame;
    if (frame.gated) return frame;
    return {
      ...frame,
      notes: [],
      rawPeaks: [],
      rawChroma: frame.rawChroma.map(() => 0),
      gated: true,
    };
  }

  update(
    frame: Pick<AnalysisFrame, "rms" | "signalToNoiseDb" | "gated">,
  ): RoomNoiseGateState {
    const settings = MICROPHONE_INPUT_PROFILE;
    const rmsDb = amplitudeToDb(frame.rms);
    const calibrated = this.calibration.length >= settings.calibrationFrames;
    const openThresholdDb = this.ambientRmsDb + settings.openMarginDb;
    const learnedSignal =
      calibrated &&
      !frame.gated &&
      rmsDb >= openThresholdDb &&
      frame.signalToNoiseDb >= settings.openSignalToNoiseDb;
    const shouldOpen = learnedSignal;
    let closedAfterLargeDrop = false;

    if (this.open) {
      const dropFromPeakDb = this.recentActivePeakRmsDb - rmsDb;
      if (dropFromPeakDb >= settings.activePeakDropDb) {
        this.dropReleaseActive = true;
      } else if (
        this.dropReleaseActive &&
        dropFromPeakDb <= settings.activePeakRecoveryDb
      ) {
        this.dropReleaseActive = false;
      }
      const shouldHold =
        !this.dropReleaseActive &&
        !frame.gated &&
        rmsDb >= this.ambientRmsDb + settings.closeMarginDb &&
        frame.signalToNoiseDb >= settings.closeSignalToNoiseDb;
      if (shouldHold) {
        this.releaseFramesRemaining = settings.releaseFrames;
      } else if (this.releaseFramesRemaining > 0) {
        this.releaseFramesRemaining -= 1;
      } else {
        this.open = false;
        closedAfterLargeDrop = this.dropReleaseActive;
        this.dropReleaseActive = false;
      }
      if (this.open && !this.dropReleaseActive) {
        this.recentActivePeakRmsDb = Math.max(
          rmsDb,
          this.recentActivePeakRmsDb - settings.activePeakDecayPerFrameDb,
        );
      }
    } else if (shouldOpen) {
      this.open = true;
      this.releaseFramesRemaining = settings.releaseFrames;
      this.recentActivePeakRmsDb = rmsDb;
    }

    if (closedAfterLargeDrop) {
      // A sustained large decay is a new background observation. Seeding the
      // floor here prevents a stale low floor from immediately reopening.
      this.ambientRmsDb = rmsDb;
      this.recentActivePeakRmsDb = -Infinity;
      this.observeNoise(rmsDb);
    } else if (!this.open && !shouldOpen) {
      // A candidate signal is never allowed to raise the learned room floor.
      this.observeNoise(rmsDb);
    }

    const isCalibrated = this.calibration.length >= settings.calibrationFrames;
    return {
      gated: frame.gated || !this.open,
      calibrated: isCalibrated,
      ambientRmsDb: this.ambientRmsDb,
      openThresholdDb: this.ambientRmsDb + settings.openMarginDb,
    };
  }

  private observeNoise(rmsDb: number): void {
    const settings = MICROPHONE_INPUT_PROFILE;
    if (this.calibration.length < settings.calibrationFrames) {
      this.calibration.push(rmsDb);
      this.ambientRmsDb = lowerQuartile(this.calibration);
      return;
    }

    // Follow a quieter room quickly and a rising floor slowly. This avoids
    // teaching sustained guitar tails to the gate as background noise.
    const alpha = rmsDb < this.ambientRmsDb ? 0.16 : 0.035;
    this.ambientRmsDb += (rmsDb - this.ambientRmsDb) * alpha;
  }
}

/** Clean input is an identity operation, including object identity. */
export function applyAudioInputProfile(
  profile: AudioInputProfileId,
  frame: AnalysisFrame,
  microphoneGate: AdaptiveRoomNoiseGate,
): AnalysisFrame {
  return profile === "microphone" ? microphoneGate.process(frame) : frame;
}

export function resolveAudioInputProfile(
  selectedProfile: AudioInputProfileId,
  sourceKind: "microphone" | "demo" | null,
): AudioInputProfileId {
  return sourceKind === "microphone" ? selectedProfile : DEFAULT_AUDIO_INPUT_PROFILE;
}

export function audioInputProfileAllowsOnset(
  profile: AudioInputProfileId,
  frameGated: boolean,
): boolean {
  return profile === "clean" || !frameGated;
}

export const DEFAULT_UI_SENSITIVITY = 50;

export type LiveAnalyzerOverrides = Pick<
  AnalyzerConfig,
  | "maxPolyphony"
  | "minConfidence"
  | "minSignalToNoiseDb"
  | "minRms"
  | "harmonicSuppression"
  | "nnlsWeight"
>;

/** Product settings shared by the UI and labelled-corpus benchmarks. */
export function createLiveAnalyzerOverrides(
  profile: LiveAnalysisProfileId,
  maxPolyphony: number,
  sensitivity = DEFAULT_UI_SENSITIVITY,
): LiveAnalyzerOverrides {
  const normalizedSensitivity = Math.max(0, Math.min(100, sensitivity));
  return {
    maxPolyphony,
    minConfidence:
      profile === "responsive"
        ? Math.max(0.09, 0.27 - normalizedSensitivity * 0.002)
        : 0.38 - normalizedSensitivity * 0.0024,
    minSignalToNoiseDb: 15 - normalizedSensitivity * 0.08,
    minRms: Number(
      Math.max(0.0006, 0.0031 - normalizedSensitivity * 0.000025).toFixed(6),
    ),
    harmonicSuppression: profile === "responsive" ? 0.98 : 0.86,
    nnlsWeight: profile === "responsive" ? 0.32 : 0.1,
  };
}
