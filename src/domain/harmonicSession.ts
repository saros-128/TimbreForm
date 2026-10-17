import {
  detectChords,
  mod12,
  type DetectedNote,
  type ChordCandidate,
} from "./music";
import {
  buildPitchClassHistogram,
  estimateLocalKey,
  type LocalKeyEstimate,
} from "./localKey";

export type ObservationOrigin = "captured" | "demo" | "preview" | "manual";
export interface CapturePosition {
  clockId: string;
  endSample: number;
  sampleRate: number;
  windowSamples: number;
}
/** Capture coordinates and delivery time deliberately use separate clocks. */
export interface HarmonicObservation {
  capture: CapturePosition;
  deliveredAtMs: number;
  origin: ObservationOrigin;
  notes: readonly DetectedNote[];
  rms: number;
  quiet: boolean;
  attack: boolean;
  attackedMidi?: number;
}
export type ActivityKind = "sound" | "silence" | "unknown" | "missing";
export interface NoteEvent {
  id: number;
  midi: number;
  startMs: number;
  endMs: number;
  confidence: number;
  boundaryUncertaintyMs: number;
}
export interface ActivityEvent {
  id: number;
  kind: ActivityKind;
  startMs: number;
  endMs: number;
}
export interface ChordEvent {
  id: number;
  startMs: number;
  endMs: number;
  midis: number[];
  candidates: ChordCandidate[];
  selected: ChordCandidate | null;
  corrected: boolean;
}
export interface HarmonicSessionView {
  clockId: string | null;
  origin: ObservationOrigin;
  nowMs: number;
  contextStartMs: number;
  notes: NoteEvent[];
  activity: ActivityEvent[];
  chords: ChordEvent[];
  attacks: number[];
}
const WINDOW_MS = 120_000;
const MAX_EVENTS = 2048;
const signature = (midis: readonly number[]) =>
  [...midis].sort((a, b) => a - b).join(",");

/** Bounded annotation buffer. It observes stable pitches, never a UI's accumulated Collect set. */
export class HarmonicSession {
  private view: HarmonicSessionView = this.empty();
  private lastMs: number | null = null;
  private nextId = 1;
  private interrupted = false;
  private active = new Map<number, NoteEvent>();
  private pending = new Map<number, number>();
  private chordSignature = "";
  private chordSince = 0;
  private chord: ChordEvent | null = null;
  private activity: ActivityEvent | null = null;
  private empty(): HarmonicSessionView {
    return {
      clockId: null,
      origin: "captured",
      nowMs: 0,
      contextStartMs: 0,
      notes: [],
      activity: [],
      chords: [],
      attacks: [],
    };
  }
  reset(): void {
    this.view = this.empty();
    this.lastMs = null;
    this.interrupted = false;
    this.active.clear();
    this.pending.clear();
    this.chord = null;
    this.activity = null;
    this.chordSignature = "";
  }
  resetContext(): void {
    this.view.contextStartMs = this.view.nowMs;
  }
  correctChord(id: number, definitionId: string, root: number): void {
    const event = this.view.chords.find((e) => e.id === id);
    const candidate = event?.candidates.find(
      (c) => c.definitionId === definitionId && c.root === root,
    );
    if (event && candidate) {
      event.selected = candidate;
      event.corrected = true;
    }
  }
  ingest(observation: HarmonicObservation): void {
    if (observation.origin === "preview" || observation.origin === "manual")
      return;
    const c = observation.capture,
      time = (c.endSample / c.sampleRate) * 1000;
    if (
      !Number.isFinite(time) ||
      c.sampleRate <= 0 ||
      !Number.isFinite(c.windowSamples) ||
      c.windowSamples <= 0 ||
      time < 0
    )
      return;
    if (
      this.view.clockId !== c.clockId ||
      this.view.origin !== observation.origin
    ) {
      this.reset();
      this.view.clockId = c.clockId;
      this.view.origin = observation.origin;
      this.view.contextStartMs = time;
    }
    if (this.lastMs !== null && time <= this.lastMs) return;
    if (
      this.lastMs !== null &&
      (this.interrupted || time - this.lastMs > 400)
    ) {
      this.endVoices(this.lastMs);
      this.view.activity.push({
        id: this.nextId++,
        kind: "missing",
        startMs: this.lastMs,
        endMs: time,
      });
      this.activity = null;
      this.pending.clear();
      this.chordSignature = "";
    }
    this.interrupted = false;
    const notes = observation.quiet
      ? []
      : observation.notes.filter(
          (n) =>
            Number.isFinite(n.midi) &&
            n.confidence >= 0.45 &&
            n.midi >= 0 &&
            n.midi <= 127,
        );
    const byMidi = new Map(notes.map((n) => [Math.round(n.midi), n]));
    for (const [midi, event] of this.active) {
      if (!byMidi.has(midi) || observation.attackedMidi === midi) {
        event.endMs = time;
        this.active.delete(midi);
        this.pending.delete(midi);
      }
    }
    for (const midi of this.pending.keys())
      if (!byMidi.has(midi)) this.pending.delete(midi);
    for (const [midi, note] of byMidi) {
      let event = this.active.get(midi);
      if (!event) {
        const since = this.pending.get(midi) ?? time;
        this.pending.set(midi, since);
        if (time - since < 70 && observation.attackedMidi !== midi) continue;
        event = {
          id: this.nextId++,
          midi,
          startMs: since,
          endMs: time,
          confidence: note.confidence,
          boundaryUncertaintyMs: (c.windowSamples / c.sampleRate) * 1000,
        };
        this.active.set(midi, event);
        this.view.notes.push(event);
      }
      event.endMs = time;
      event.confidence = Math.min(event.confidence, note.confidence);
    }
    const kind: ActivityKind = observation.quiet
      ? "silence"
      : this.active.size
        ? "sound"
        : "unknown";
    if (this.activity?.kind === kind) {
      this.activity.endMs = time;
    } else {
      this.activity = {
        id: this.nextId++,
        kind,
        startMs: this.lastMs ?? time,
        endMs: time,
      };
      this.view.activity.push(this.activity);
    }
    if (observation.attack) this.view.attacks.push(time);
    const midis = [...this.active.keys()].sort((a, b) => a - b),
      nextSignature = signature(midis);
    if (this.chord && signature(this.chord.midis) !== nextSignature) {
      this.chord.endMs = time;
      this.chord = null;
    }
    if (observation.attack && this.chord && time - this.chord.startMs >= 180) {
      this.chord.endMs = time;
      this.chord = null;
      this.chordSince = time;
    }
    if (nextSignature !== this.chordSignature) {
      this.chordSignature = nextSignature;
      this.chordSince = time;
    }
    if (midis.length >= 2 && time - this.chordSince >= 180 && !this.chord) {
      const candidates = detectChords(midis.map(mod12), mod12(midis[0])).slice(
        0,
        5,
      );
      this.chord = {
        id: this.nextId++,
        startMs: this.chordSince,
        endMs: time,
        midis,
        candidates,
        selected: candidates[0] ?? null,
        corrected: false,
      };
      this.view.chords.push(this.chord);
    }
    if (this.chord) this.chord.endMs = time;
    this.view.nowMs = time;
    this.lastMs = time;
    const cutoff = time - WINDOW_MS;
    this.view.notes = this.view.notes
      .filter((e) => e.endMs >= cutoff)
      .slice(-MAX_EVENTS);
    this.view.activity = this.view.activity
      .filter((e) => e.endMs >= cutoff)
      .slice(-MAX_EVENTS);
    this.view.chords = this.view.chords
      .filter((e) => e.endMs >= cutoff)
      .slice(-512);
    this.view.attacks = this.view.attacks
      .filter((t) => t >= cutoff)
      .slice(-MAX_EVENTS);
  }
  private endVoices(time: number): void {
    for (const event of this.active.values()) event.endMs = time;
    if (this.chord) this.chord.endMs = time;
    if (this.activity) this.activity.endMs = time;
    this.active.clear();
    this.chord = null;
  }
  stop(): void {
    this.interrupted = true;
    if (this.lastMs !== null) this.endVoices(this.lastMs);
    this.pending.clear();
    this.chordSignature = "";
    this.activity = null;
  }
  snapshot(): HarmonicSessionView {
    return {
      ...this.view,
      notes: this.view.notes.map((e) => ({ ...e })),
      activity: this.view.activity.map((e) => ({ ...e })),
      chords: this.view.chords.map((e) => ({ ...e, midis: [...e.midis] })),
      attacks: [...this.view.attacks],
    };
  }
}

export function sessionContext(view: HarmonicSessionView): {
  estimate: LocalKeyEstimate;
  bins: number[];
  coverageMs: number;
} {
  const start = Math.max(view.contextStartMs, view.nowMs - WINDOW_MS);
  // Group near-simultaneous onsets so a chord is one piece of evidence. Long
  // drones are capped; every UI frame is never counted as a new observation.
  const onsets = new Map<number, typeof view.notes>();
  for (const note of view.notes)
    if (note.endMs > start) {
      const key = Math.round(note.startMs / 100);
      const group = onsets.get(key) ?? [];
      group.push(note);
      onsets.set(key, group);
    }
  const groups = [...onsets.values()].map((notes) => ({
    pitches: notes.map((n) => ({
      pitchClass: mod12(n.midi),
      weight: n.confidence / notes.length,
    })),
    weight:
      notes.reduce(
        (sum, n) =>
          sum +
          (Math.min(8000, Math.max(0, n.endMs - Math.max(start, n.startMs))) /
            1000) *
            Math.pow(0.5, (view.nowMs - n.endMs) / 30000),
        0,
      ) / notes.length,
  }));
  const histogram = buildPitchClassHistogram(groups);
  const estimate = estimateLocalKey(histogram, 3);
  const distinct = new Set(
    groups.map((g) =>
      g.pitches
        .map((p) => p.pitchClass)
        .sort((a, b) => a - b)
        .join(","),
    ),
  );
  if (distinct.size < 3 || histogram.distinctPitchClasses < 4) {
    estimate.status = "insufficient";
    estimate.candidates = [];
    estimate.tonic = null;
  }
  return {
    estimate,
    bins: [...histogram.bins],
    coverageMs: Math.max(0, view.nowMs - start),
  };
}
