import { describe, it, expect } from "vitest";
import {
  HarmonicSession,
  sessionContext,
  type HarmonicObservation,
} from "./harmonicSession";
import { mod12, midiToFrequency } from "./music";
function observation(
  time: number,
  midis: number[],
  extra: Partial<HarmonicObservation> = {},
): HarmonicObservation {
  return {
    capture: {
      clockId: "guitar",
      endSample: time * 48,
      sampleRate: 48000,
      windowSamples: 4096,
    },
    deliveredAtMs: time + 10000,
    origin: "captured",
    notes: midis.map((midi) => ({
      midi,
      pitchClass: mod12(midi),
      frequency: midiToFrequency(midi),
      cents: 0,
      amplitude: 0.3,
      confidence: 0.9,
    })),
    rms: 0.1,
    quiet: false,
    attack: false,
    ...extra,
  };
}
function hold(s: HarmonicSession, start: number, end: number, midis: number[]) {
  for (let t = start; t <= end; t += 50) s.ingest(observation(t, midis));
}
describe("captured annotation", () => {
  it("uses capture sample positions and ignores delivery delays and previews", () => {
    const s = new HarmonicSession();
    hold(s, 0, 500, [53, 56, 60]);
    const before = s.snapshot();
    expect(before.nowMs).toBe(500);
    s.ingest(observation(1000, [72], { origin: "preview" }));
    expect(s.snapshot()).toEqual(before);
    expect(before.chords[0].midis).toEqual([53, 56, 60]);
  });
  it("separates silence, unknown sound, dropped data, and repeated attacks", () => {
    const s = new HarmonicSession();
    hold(s, 0, 500, [60]);
    s.ingest(observation(550, [60], { attack: true, attackedMidi: 60 }));
    s.ingest(observation(600, [], { quiet: true }));
    s.ingest(observation(650, []));
    s.ingest(observation(1400, []));
    const v = s.snapshot();
    expect(v.notes).toHaveLength(2);
    expect(v.notes[1].startMs).toBe(550);
    expect(v.activity.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["sound", "silence", "unknown", "missing"]),
    );
    expect(v.activity.find((a) => a.kind === "missing")).toMatchObject({
      startMs: 650,
      endMs: 1400,
    });
  });
  it("marks even a short audition interruption as missing, without bridging notes", () => {
    const s = new HarmonicSession();
    hold(s, 0, 400, [60]);
    s.stop();
    hold(s, 550, 800, [60]);
    expect(
      s.snapshot().activity.find((a) => a.kind === "missing"),
    ).toMatchObject({ startMs: 400, endMs: 550 });
    expect(s.snapshot().notes).toHaveLength(2);
  });
  it("does not turn a held chord into confident key evidence; reset preserves the phrase", () => {
    const s = new HarmonicSession();
    hold(s, 0, 2000, [60, 64, 67]);
    expect(sessionContext(s.snapshot()).estimate.status).toBe("insufficient");
    hold(s, 2050, 4000, [65, 69, 72]);
    hold(s, 4050, 6000, [67, 71, 74]);
    expect(
      sessionContext(s.snapshot()).bins.filter((v) => v > 0).length,
    ).toBeGreaterThan(4);
    const length = s.snapshot().chords.length;
    s.resetContext();
    expect(sessionContext(s.snapshot()).estimate.status).toBe("insufficient");
    expect(s.snapshot().chords).toHaveLength(length);
  });
  it("accepts melodic evidence and expires old events after two minutes", () => {
    const s = new HarmonicSession();
    [60, 62, 64, 65, 67, 69, 71].forEach((n, i) =>
      hold(s, i * 1000, i * 1000 + 950, [n]),
    );
    expect(
      sessionContext(s.snapshot()).estimate.candidates.length,
    ).toBeGreaterThan(0);
    hold(s, 127000, 128000, []);
    expect(s.snapshot().notes).toHaveLength(0);
  });
  it("keeps measured notes when correcting a chord interpretation", () => {
    const s = new HarmonicSession();
    hold(s, 0, 800, [60, 64, 67, 71]);
    const e = s.snapshot().chords[0],
      other = e.candidates[1];
    expect(other).toBeDefined();
    s.correctChord(e.id, other.definitionId, other.root);
    expect(s.snapshot().chords[0]).toMatchObject({
      midis: e.midis,
      selected: other,
      corrected: true,
    });
  });
});
