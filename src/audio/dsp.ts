import {
  frequencyToMidi,
  midiToFrequency,
  mod12,
  type DetectedNote,
} from "../domain/music";

export interface SpectrumInput {
  capture?: import("../domain/harmonicSession").CapturePosition;
  frequencyData: Float32Array;
  timeData: Float32Array;
  sampleRate: number;
  fftSize: number;
  timestampMs: number;
}

export interface RawPeak {
  frequency: number;
  midi: number;
  pitchClass: number;
  amplitude: number;
  db: number;
}

export interface AnalyzerConfig {
  a4: number;
  minMidi: number;
  maxMidi: number;
  maxPolyphony: number;
  minConfidence: number;
  minSignalToNoiseDb: number;
  minRms: number;
  harmonicSuppression: number;
  nnlsWeight: number;
}

export interface AnalysisFrame {
  timestampMs: number;
  notes: DetectedNote[];
  rawPeaks: RawPeak[];
  rawChroma: number[];
  rms: number;
  inputPeakDb: number;
  peakDb: number;
  noiseFloorDb: number;
  signalToNoiseDb: number;
  gated: boolean;
}

export interface MonophonicPitch {
  note: DetectedNote;
  clarity: number;
}

export function positiveDifferenceSpectrum(
  after: Float32Array,
  before: Float32Array,
  retention = 1.04,
): Float32Array<ArrayBuffer> {
  const length = Math.min(after.length, before.length);
  const difference = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const afterDb = safeDb(after[index]);
    const beforeDb = safeDb(before[index]);
    const afterPower = 10 ** (afterDb / 10);
    const beforePower = 10 ** (beforeDb / 10);
    const deltaPower = Math.max(1e-12, afterPower - beforePower * retention);
    difference[index] = 10 * Math.log10(deltaPower);
  }
  return difference;
}

export function positiveSpectralFlux(
  after: Float32Array,
  before: Float32Array,
  sampleRate: number,
  fftSize: number,
): number {
  const binHz = sampleRate / fftSize;
  const start = Math.max(1, Math.floor(70 / binHz));
  const end = Math.min(after.length, before.length, Math.ceil(5000 / binHz));
  let positive = 0;
  let total = 0;
  for (let index = start; index < end; index += 2) {
    const afterAmplitude = 10 ** (safeDb(after[index]) / 20);
    const beforeAmplitude = 10 ** (safeDb(before[index]) / 20);
    positive += Math.max(0, afterAmplitude - beforeAmplitude);
    total += afterAmplitude;
  }
  return clamp(positive / Math.max(1e-9, total), 0, 1);
}

export const DEFAULT_ANALYZER_CONFIG: AnalyzerConfig = {
  a4: 440,
  minMidi: 40,
  maxMidi: 88,
  maxPolyphony: 4,
  minConfidence: 0.26,
  minSignalToNoiseDb: 10,
  minRms: 0.0025,
  harmonicSuppression: 0.86,
  nnlsWeight: 0.1,
};

const HARMONIC_WEIGHTS = [1, 0.82, 0.68, 0.56, 0.47, 0.4, 0.34, 0.29];
const LOG_MIN_FREQUENCY = 55;
const LOG_MAX_FREQUENCY = 5000;
const LOG_BINS_PER_OCTAVE = 36;

interface HarmonicDictionary {
  columns: Float32Array[];
  frequencies: Float32Array;
  midiValues: number[];
}

const dictionaryCache = new Map<string, HarmonicDictionary>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeDb(value: number): number {
  return Number.isFinite(value) ? value : -120;
}

function rmsOf(values: Float32Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    sum += value * value;
  }
  return Math.sqrt(sum / values.length);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return -120;
  values.sort((a, b) => a - b);
  return values[Math.floor(clamp(ratio, 0, 1) * (values.length - 1))];
}

function localMax(values: Float32Array, bin: number, radius = 1): number {
  const center = Math.round(bin);
  let result = 0;
  for (
    let index = Math.max(1, center - radius);
    index <= Math.min(values.length - 2, center + radius);
    index += 1
  ) {
    result = Math.max(result, values[index]);
  }
  return result;
}

function getHarmonicDictionary(config: AnalyzerConfig): HarmonicDictionary {
  const cacheKey = `${config.minMidi}:${config.maxMidi}:${config.a4}`;
  const cached = dictionaryCache.get(cacheKey);
  if (cached) return cached;

  const binCount =
    Math.floor(LOG_BINS_PER_OCTAVE * Math.log2(LOG_MAX_FREQUENCY / LOG_MIN_FREQUENCY)) +
    1;
  const frequencies = new Float32Array(binCount);
  for (let bin = 0; bin < binCount; bin += 1) {
    frequencies[bin] = LOG_MIN_FREQUENCY * 2 ** (bin / LOG_BINS_PER_OCTAVE);
  }

  const midiValues: number[] = [];
  const columns: Float32Array[] = [];
  for (let midi = config.minMidi; midi <= config.maxMidi; midi += 1) {
    const fundamental = midiToFrequency(midi, config.a4);
    const relativePitch =
      (midi - config.minMidi) / Math.max(1, config.maxMidi - config.minMidi);
    const harmonicDecay = 0.9 - relativePitch * 0.3;
    const column = new Float32Array(binCount);

    for (let harmonic = 1; harmonic <= 12; harmonic += 1) {
      const frequency = fundamental * harmonic;
      if (frequency > LOG_MAX_FREQUENCY) break;
      const center = LOG_BINS_PER_OCTAVE * Math.log2(frequency / LOG_MIN_FREQUENCY);
      const amplitude = harmonicDecay ** (harmonic - 1);
      const start = Math.max(0, Math.floor(center - 4));
      const end = Math.min(binCount - 1, Math.ceil(center + 4));
      for (let bin = start; bin <= end; bin += 1) {
        const distance = bin - center;
        column[bin] += amplitude * Math.exp(-(distance * distance) / 2);
      }
    }

    let norm = 0;
    for (let bin = 0; bin < column.length; bin += 1) norm += column[bin] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let bin = 0; bin < column.length; bin += 1) column[bin] /= norm;
    midiValues.push(midi);
    columns.push(column);
  }

  const dictionary = { columns, frequencies, midiValues };
  dictionaryCache.set(cacheKey, dictionary);
  return dictionary;
}

function logFrequencyEvidence(
  normalizedSpectrum: Float32Array,
  sampleRate: number,
  fftSize: number,
  config: AnalyzerConfig,
): Map<number, number> {
  const dictionary = getHarmonicDictionary(config);
  const binHz = sampleRate / fftSize;
  const logSpectrum = new Float32Array(dictionary.frequencies.length);
  for (let index = 0; index < logSpectrum.length; index += 1) {
    const fftBin = dictionary.frequencies[index] / binHz;
    logSpectrum[index] = localMax(normalizedSpectrum, fftBin, fftBin < 80 ? 1 : 2);
  }

  const standardized = new Float32Array(logSpectrum.length);
  const neighborhood = 18;
  for (let index = 0; index < logSpectrum.length; index += 1) {
    const start = Math.max(0, index - neighborhood);
    const end = Math.min(logSpectrum.length - 1, index + neighborhood);
    let sum = 0;
    let squareSum = 0;
    let weightSum = 0;
    for (let neighbor = start; neighbor <= end; neighbor += 1) {
      const relative = (neighbor - index) / neighborhood;
      const weight = 0.54 + 0.46 * Math.cos(Math.PI * relative);
      const value = logSpectrum[neighbor];
      sum += value * weight;
      squareSum += value * value * weight;
      weightSum += weight;
    }
    const mean = sum / Math.max(1e-9, weightSum);
    const variance = Math.max(1e-7, squareSum / Math.max(1e-9, weightSum) - mean * mean);
    standardized[index] = Math.max(0, (logSpectrum[index] - mean) / Math.sqrt(variance));
  }

  let spectrumNorm = 0;
  for (let index = 0; index < standardized.length; index += 1) {
    spectrumNorm += standardized[index] ** 2;
  }
  spectrumNorm = Math.sqrt(spectrumNorm) || 1;
  const target = standardized.map((value) => value / spectrumNorm);

  const activations = new Float32Array(dictionary.columns.length);
  const residual = target.slice();
  let maximumCorrelation = 0;
  for (const column of dictionary.columns) {
    let correlation = 0;
    for (let bin = 0; bin < column.length; bin += 1) correlation += column[bin] * target[bin];
    maximumCorrelation = Math.max(maximumCorrelation, correlation);
  }
  const sparsity = maximumCorrelation * 0.045;

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const reverse = iteration % 2 === 1;
    for (let step = 0; step < dictionary.columns.length; step += 1) {
      const pitchIndex = reverse ? dictionary.columns.length - 1 - step : step;
      const column = dictionary.columns[pitchIndex];
      const previous = activations[pitchIndex];
      let correlation = 0;
      let norm = 0;
      for (let bin = 0; bin < column.length; bin += 1) {
        correlation += column[bin] * (residual[bin] + column[bin] * previous);
        norm += column[bin] ** 2;
      }
      const next = Math.max(0, (correlation - sparsity) / Math.max(1e-9, norm));
      const delta = next - previous;
      if (Math.abs(delta) < 1e-7) continue;
      activations[pitchIndex] = next;
      for (let bin = 0; bin < column.length; bin += 1) residual[bin] -= column[bin] * delta;
    }
  }

  const sorted = [...activations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
  const maximum = sorted.at(-1) ?? 0;
  const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)] ?? maximum;
  const threshold = Math.max(maximum * 0.1, median + mad * 2.5);
  const scale = Math.max(maximum * 0.35, p95 - threshold, 1e-6);
  const evidence = new Map<number, number>();

  for (let index = 0; index < activations.length; index += 1) {
    const activation = activations[index];
    if (activation <= threshold) {
      evidence.set(dictionary.midiValues[index], 0);
      continue;
    }

    const midi = dictionary.midiValues[index];
    const fundamental = midiToFrequency(midi, config.a4);
    let supportCount = 0;
    let lowOrderSupport = false;
    let thirdSupported = false;
    let fifthSupported = false;
    for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
      const frequency = fundamental * harmonic;
      if (frequency > LOG_MAX_FREQUENCY) break;
      const logBin = Math.round(
        LOG_BINS_PER_OCTAVE * Math.log2(frequency / LOG_MIN_FREQUENCY),
      );
      let support = 0;
      for (
        let neighbor = Math.max(0, logBin - 1);
        neighbor <= Math.min(standardized.length - 1, logBin + 1);
        neighbor += 1
      ) {
        support = Math.max(support, standardized[neighbor]);
      }
      if (support > 1.35) {
        supportCount += 1;
        if (harmonic <= 2) lowOrderSupport = true;
        if (harmonic === 3) thirdSupported = true;
        if (harmonic === 5) fifthSupported = true;
      }
    }

    const validSupport = lowOrderSupport || (thirdSupported && fifthSupported);
    const normalizedActivation = clamp((activation - threshold) / scale, 0, 1);
    const supportFactor = clamp((supportCount - 1) / 3, 0, 1);
    evidence.set(
      midi,
      validSupport ? clamp(normalizedActivation * 0.78 + supportFactor * 0.22, 0, 1) : 0,
    );
  }
  return evidence;
}

function strongestBin(values: Float32Array, bin: number, radius = 1): number {
  const center = Math.round(bin);
  let bestIndex = clamp(center, 1, values.length - 2);
  let bestValue = values[bestIndex];
  for (
    let index = Math.max(1, center - radius);
    index <= Math.min(values.length - 2, center + radius);
    index += 1
  ) {
    if (values[index] > bestValue) {
      bestValue = values[index];
      bestIndex = index;
    }
  }
  return bestIndex;
}

function parabolicBin(values: Float32Array, index: number): number {
  if (index <= 0 || index >= values.length - 1) return index;
  const left = values[index - 1];
  const center = values[index];
  const right = values[index + 1];
  const denominator = left - 2 * center + right;
  if (Math.abs(denominator) < 1e-9) return index;
  return index + clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
}

function scanPitchCandidate(
  midi: number,
  residual: Float32Array,
  sampleRate: number,
  fftSize: number,
  a4: number,
): { score: number; offsetCents: number; fundamental: number; coherence: number } {
  const binHz = sampleRate / fftSize;
  let best = { score: 0, offsetCents: 0, fundamental: 0, coherence: 0 };

  for (let offsetCents = -35; offsetCents <= 35; offsetCents += 5) {
    const frequency = midiToFrequency(midi + offsetCents / 100, a4);
    let weighted = 0;
    let totalWeight = 0;
    let coherentHarmonics = 0;
    let availableHarmonics = 0;
    let fundamental = 0;

    for (let harmonic = 1; harmonic <= HARMONIC_WEIGHTS.length; harmonic += 1) {
      const harmonicFrequency = frequency * harmonic;
      const bin = harmonicFrequency / binHz;
      if (harmonicFrequency > LOG_MAX_FREQUENCY || bin >= residual.length - 2) break;

      const amplitude = localMax(residual, bin, harmonic <= 2 ? 1 : 2);
      const weight = HARMONIC_WEIGHTS[harmonic - 1];
      availableHarmonics += 1;
      weighted += amplitude * weight;
      totalWeight += weight;
      if (amplitude >= 0.075) coherentHarmonics += 1;
      if (harmonic === 1) fundamental = amplitude;
    }

    const harmonicMean = totalWeight > 0 ? weighted / totalWeight : 0;
    const coherence = coherentHarmonics / Math.max(1, availableHarmonics);
    const fundamentalBin = strongestBin(residual, frequency / binHz, 1);
    const resolvedMidi = frequencyToMidi(fundamentalBin * binHz, a4);
    const pitchConsistency = Math.abs(resolvedMidi - midi) <= 0.5 ? 1 : 0.12;
    const score =
      (fundamental * 0.5 + harmonicMean * 0.4 + coherence * 0.1) * pitchConsistency;
    if (score > best.score) {
      best = { score, offsetCents, fundamental, coherence };
    }
  }

  return best;
}

function suppressHarmonicTemplate(
  residual: Float32Array,
  frequency: number,
  sampleRate: number,
  fftSize: number,
  baseAmplitude: number,
  amount: number,
): void {
  const binHz = sampleRate / fftSize;
  for (let harmonic = 1; harmonic <= 14; harmonic += 1) {
    const bin = Math.round((frequency * harmonic) / binHz);
    if (bin >= residual.length - 2) break;
    const expected = baseAmplitude / harmonic ** 0.72;
    const radius = harmonic <= 2 ? 2 : 3;
    for (
      let index = Math.max(1, bin - radius);
      index <= Math.min(residual.length - 2, bin + radius);
      index += 1
    ) {
      residual[index] = Math.max(0, residual[index] - expected * amount);
    }
  }
}

function extractRawPeaks(
  frequencyData: Float32Array,
  normalized: Float32Array,
  sampleRate: number,
  fftSize: number,
  a4: number,
): RawPeak[] {
  const binHz = sampleRate / fftSize;
  const minBin = Math.max(2, Math.floor(60 / binHz));
  const maxBin = Math.min(frequencyData.length - 2, Math.ceil(5000 / binHz));
  const peaks: RawPeak[] = [];

  for (let index = minBin; index <= maxBin; index += 1) {
    const amplitude = normalized[index];
    if (
      amplitude < 0.065 ||
      amplitude <= normalized[index - 1] ||
      amplitude < normalized[index + 1]
    ) {
      continue;
    }

    const refined = parabolicBin(normalized, index);
    const frequency = refined * binHz;
    const midi = frequencyToMidi(frequency, a4);
    peaks.push({
      frequency,
      midi,
      pitchClass: mod12(Math.round(midi)),
      amplitude,
      db: safeDb(frequencyData[index]),
    });
  }

  return peaks.sort((a, b) => b.amplitude - a.amplitude).slice(0, 48);
}

function buildRawChroma(peaks: readonly RawPeak[]): number[] {
  const chroma = Array.from({ length: 12 }, () => 0);
  for (const peak of peaks) {
    const frequencyWeight = 1 / Math.sqrt(Math.max(1, peak.frequency / 110));
    chroma[peak.pitchClass] += peak.amplitude * frequencyWeight;
  }
  const maximum = Math.max(...chroma, 0.0001);
  return chroma.map((value) => clamp(value / maximum, 0, 1));
}

export function analyzeSpectrum(
  input: SpectrumInput,
  config: AnalyzerConfig = DEFAULT_ANALYZER_CONFIG,
): AnalysisFrame {
  const { frequencyData, timeData, sampleRate, fftSize, timestampMs } = input;
  const binHz = sampleRate / fftSize;
  const minFrequency = midiToFrequency(config.minMidi - 1, config.a4);
  const maxFrequency = Math.min(6000, sampleRate / 2);
  const minBin = Math.max(1, Math.floor(minFrequency / binHz));
  const maxBin = Math.min(frequencyData.length - 1, Math.ceil(maxFrequency / binHz));

  const sampledDb: number[] = [];
  let peakDb = -120;
  for (let index = minBin; index <= maxBin; index += 1) {
    const db = safeDb(frequencyData[index]);
    peakDb = Math.max(peakDb, db);
    if (index % 8 === 0) sampledDb.push(db);
  }
  const noiseFloorDb = Math.max(-120, percentile(sampledDb, 0.35));
  const signalToNoiseDb = Math.min(120, peakDb - noiseFloorDb);
  const rms = rmsOf(timeData);
  const inputPeak = timeData.reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)),
    0,
  );
  const inputPeakDb = 20 * Math.log10(Math.max(inputPeak, 1e-6));
  const gated =
    rms < config.minRms || signalToNoiseDb < config.minSignalToNoiseDb || peakDb < -96;

  const normalized = new Float32Array(frequencyData.length);
  const noiseRelativeAmplitude = 10 ** ((noiseFloorDb - peakDb) / 20);
  for (let index = minBin; index <= maxBin; index += 1) {
    const relativeAmplitude = 10 ** ((safeDb(frequencyData[index]) - peakDb) / 20);
    normalized[index] = clamp(
      (relativeAmplitude - noiseRelativeAmplitude) / Math.max(1e-6, 1 - noiseRelativeAmplitude),
      0,
      1,
    );
  }

  const rawPeaks = gated
    ? []
    : extractRawPeaks(frequencyData, normalized, sampleRate, fftSize, config.a4);
  const rawChroma = gated ? Array.from({ length: 12 }, () => 0) : buildRawChroma(rawPeaks);
  if (gated) {
    return {
      timestampMs,
      notes: [],
      rawPeaks,
      rawChroma,
      rms,
      inputPeakDb,
      peakDb,
      noiseFloorDb,
      signalToNoiseDb,
      gated,
    };
  }

  const nnlsEvidence = logFrequencyEvidence(
    normalized,
    sampleRate,
    fftSize,
    config,
  );
  const residual = normalized.slice();
  const notes: DetectedNote[] = [];
  const usedPitchClasses = new Set<number>();

  for (let slot = 0; slot < config.maxPolyphony; slot += 1) {
    let bestMidi = -1;
    let bestCombinedScore = 0;
    let best = { score: 0, offsetCents: 0, fundamental: 0, coherence: 0 };

    for (let midi = config.minMidi; midi <= config.maxMidi; midi += 1) {
      if (usedPitchClasses.has(mod12(midi))) continue;
      const candidate = scanPitchCandidate(
        midi,
        residual,
        sampleRate,
        fftSize,
        config.a4,
      );
      const evidence = nnlsEvidence.get(midi) ?? 0;
      const combinedScore =
        candidate.score * (1 - config.nnlsWeight) + evidence * config.nnlsWeight;
      if (combinedScore > bestCombinedScore) {
        bestMidi = midi;
        best = candidate;
        bestCombinedScore = combinedScore;
      }
    }

    if (bestMidi < 0 || bestCombinedScore < config.minConfidence) break;

    const nominalFrequency = midiToFrequency(bestMidi + best.offsetCents / 100, config.a4);
    const localBin = strongestBin(normalized, nominalFrequency / binHz, 2);
    const localFrequency = parabolicBin(normalized, localBin) * binHz;
    const localMidi = frequencyToMidi(localFrequency, config.a4);
    const estimatedMidi =
      Math.abs(localMidi - bestMidi) <= 0.5
        ? localMidi
        : bestMidi + best.offsetCents / 100;
    const refinedFrequency = midiToFrequency(estimatedMidi, config.a4);
    const cents = clamp((estimatedMidi - bestMidi) * 100, -50, 50);
    const pitchClass = mod12(bestMidi);
    const confidence = clamp(
      bestCombinedScore * 0.88 +
        best.coherence * 0.12 +
        Math.min(0.08, signalToNoiseDb / 500),
      0,
      1,
    );

    notes.push({
      midi: bestMidi,
      pitchClass,
      frequency: refinedFrequency,
      cents,
      confidence,
      amplitude: best.fundamental,
    });
    usedPitchClasses.add(pitchClass);
    suppressHarmonicTemplate(
      residual,
      nominalFrequency,
      sampleRate,
      fftSize,
      Math.max(best.fundamental, best.score),
      config.harmonicSuppression,
    );
  }

  notes.sort((a, b) => a.midi - b.midi);
  return {
    timestampMs,
    notes,
    rawPeaks,
    rawChroma,
    rms,
    inputPeakDb,
    peakDb,
    noiseFloorDb,
    signalToNoiseDb,
    gated,
  };
}

export function estimateMonophonicPitch(
  samples: Float32Array,
  sampleRate: number,
  a4 = 440,
): MonophonicPitch | null {
  if (samples.length < 1024) return null;

  const downsample = Math.max(1, Math.round(sampleRate / 24_000));
  const targetDurationSeconds = 4096 / 48_000;
  const usableLength = Math.min(
    Math.round(sampleRate * targetDurationSeconds),
    samples.length,
  );
  const start = samples.length - usableLength;
  const data = new Float32Array(Math.floor(usableLength / downsample));
  let mean = 0;
  for (let index = 0; index < data.length; index += 1) {
    let blockSum = 0;
    for (let offset = 0; offset < downsample; offset += 1) {
      blockSum += samples[start + index * downsample + offset];
    }
    data[index] = blockSum / downsample;
    mean += data[index];
  }
  mean /= data.length;
  let energy = 0;
  for (let index = 0; index < data.length; index += 1) {
    data[index] -= mean;
    energy += data[index] * data[index];
  }
  const localRms = Math.sqrt(energy / data.length);
  if (localRms < 0.003) return null;

  const effectiveRate = sampleRate / downsample;
  const minTau = Math.max(2, Math.floor(effectiveRate / 1400));
  const maxTau = Math.min(data.length >> 1, Math.ceil(effectiveRate / 70));
  const difference = new Float32Array(maxTau + 1);
  const comparisonLength = data.length - maxTau;

  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0;
    for (let index = 0; index < comparisonLength; index += 1) {
      const delta = data[index] - data[index + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  const normalized = new Float32Array(maxTau + 1);
  normalized[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    running += difference[tau];
    normalized[tau] = running > 0 ? (difference[tau] * tau) / running : 1;
  }

  let bestTau = -1;
  for (let tau = minTau; tau < maxTau; tau += 1) {
    if (normalized[tau] < 0.16) {
      while (tau + 1 <= maxTau && normalized[tau + 1] < normalized[tau]) tau += 1;
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) {
    let bestValue = 1;
    for (let tau = minTau; tau <= maxTau; tau += 1) {
      if (normalized[tau] < bestValue) {
        bestValue = normalized[tau];
        bestTau = tau;
      }
    }
  }

  if (bestTau < 0) return null;
  const clarity = 1 - normalized[bestTau];
  if (clarity < 0.68) return null;

  const refinedTau = parabolicBin(
    normalized.map((value) => -value) as Float32Array,
    bestTau,
  );
  const frequency = effectiveRate / refinedTau;
  if (!Number.isFinite(frequency) || frequency < 70 || frequency > 1400) return null;

  const estimatedMidi = frequencyToMidi(frequency, a4);
  const roundedMidi = Math.round(estimatedMidi);
  return {
    clarity,
    note: {
      midi: roundedMidi,
      pitchClass: mod12(roundedMidi),
      frequency,
      cents: clamp((estimatedMidi - roundedMidi) * 100, -50, 50),
      confidence: clamp(clarity, 0, 1),
      amplitude: clamp(localRms * 8, 0, 1),
    },
  };
}
