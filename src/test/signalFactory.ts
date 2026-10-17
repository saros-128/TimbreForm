import { midiToFrequency } from "../domain/music";
import type { SpectrumInput } from "../audio/dsp";
import { LIVE_ANALYSIS_PROFILE } from "../audio/profile";

interface SyntheticOptions {
  sampleRate?: number;
  fftSize?: number;
  harmonicDecay?: number;
  noiseDb?: number;
  noteLevels?: number[];
  missingFundamental?: boolean;
}

export function syntheticFrame(
  midis: readonly number[],
  options: SyntheticOptions = {},
): SpectrumInput {
  const sampleRate = options.sampleRate ?? 48_000;
  const fftSize = options.fftSize ?? LIVE_ANALYSIS_PROFILE.fftSize;
  const binCount = fftSize / 2;
  const harmonicDecay = options.harmonicDecay ?? 0.82;
  const noiseDb = options.noiseDb ?? -108;
  const noisePower = 10 ** (noiseDb / 10);
  const powers = new Float64Array(binCount);
  powers.fill(noisePower);

  midis.forEach((midi, noteIndex) => {
    const fundamental = midiToFrequency(midi);
    const noteLevel = options.noteLevels?.[noteIndex] ?? 1;
    for (let harmonic = 1; harmonic <= 12; harmonic += 1) {
      if (harmonic === 1 && options.missingFundamental) continue;
      const frequency = fundamental * harmonic;
      if (frequency >= sampleRate / 2) break;
      const bin = (frequency * fftSize) / sampleRate;
      const amplitude = (0.28 * noteLevel) / harmonic ** harmonicDecay;
      for (let offset = -4; offset <= 4; offset += 1) {
        const index = Math.round(bin) + offset;
        if (index <= 0 || index >= powers.length) continue;
        const distance = index - bin;
        const leakage = Math.exp(-(distance * distance) / 1.25);
        powers[index] += amplitude * amplitude * leakage;
      }
    }
  });

  const frequencyData = new Float32Array(binCount);
  for (let index = 0; index < binCount; index += 1) {
    frequencyData[index] = 10 * Math.log10(Math.max(noisePower, powers[index]));
  }

  const timeData = syntheticWave(midis, { sampleRate, length: fftSize });
  return {
    frequencyData,
    timeData,
    sampleRate,
    fftSize,
    timestampMs: 1000,
  };
}

export function syntheticWave(
  midis: readonly number[],
  options: { sampleRate?: number; length?: number } = {},
): Float32Array {
  const sampleRate = options.sampleRate ?? 48_000;
  const length = options.length ?? 4096;
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let value = 0;
    midis.forEach((midi, noteIndex) => {
      const phase = noteIndex * 0.71;
      value += Math.sin((2 * Math.PI * midiToFrequency(midi) * index) / sampleRate + phase);
    });
    samples[index] = (value * 0.12) / Math.max(1, midis.length);
  }
  return samples;
}
