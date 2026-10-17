import type { DetectedNote } from "../domain/music";

export type NoteLifecycle = "candidate" | "active" | "releasing";

export interface TrackedNote extends DetectedNote {
  state: NoteLifecycle;
  firstSeenMs: number;
  lastSeenMs: number;
  ageMs: number;
}

export interface TrackerConfig {
  fastAttackWindowMs: number;
  evidenceWindowMs: number;
  releaseMs: number;
  strongHitConfidence: number;
  fastAttackHits: number;
  weakAttackHits: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  fastAttackWindowMs: 96,
  evidenceWindowMs: 160,
  releaseMs: 160,
  strongHitConfidence: 0.45,
  fastAttackHits: 2,
  weakAttackHits: 3,
};

interface EvidenceHit {
  timestampMs: number;
  note: DetectedNote;
}

interface TrackerEntry {
  note: TrackedNote;
  hits: EvidenceHit[];
}

function hitCountForMidi(hits: readonly EvidenceHit[], midi: number): number {
  return hits.reduce(
    (count, hit) => count + (hit.note.midi === midi ? 1 : 0),
    0,
  );
}

function strongestRepresentative(hits: readonly EvidenceHit[]): DetectedNote {
  const byMidi = new Map<
    number,
    { count: number; confidence: number; latest: DetectedNote }
  >();
  for (const hit of hits) {
    const current = byMidi.get(hit.note.midi);
    byMidi.set(hit.note.midi, {
      count: (current?.count ?? 0) + 1,
      confidence: (current?.confidence ?? 0) + hit.note.confidence,
      latest: hit.note,
    });
  }
  return [...byMidi.values()].sort(
    (left, right) =>
      right.count - left.count || right.confidence - left.confidence,
  )[0].latest;
}

/**
 * Pitch-class evidence tracker for the Live chord set.
 *
 * A single reducer frame is never enough to add a note. Two strong hits inside
 * three analysis hops, or three weaker hits inside five hops, confirm it. A
 * missing frame no longer destroys a candidate, and release tails are bounded
 * and capped to the user's requested polyphony.
 */
export class NoteTracker {
  private readonly tracked = new Map<number, TrackerEntry>();
  private readonly config: TrackerConfig;

  constructor(config: Partial<TrackerConfig> = {}) {
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
  }

  reset(): void {
    this.tracked.clear();
  }

  update(
    notes: readonly DetectedNote[],
    timestampMs: number,
    maximumNotes = Number.POSITIVE_INFINITY,
  ): TrackedNote[] {
    const incoming = new Map(notes.map((note) => [note.pitchClass, note]));
    const observedNow = new Set(incoming.keys());

    for (const [pitchClass, entry] of this.tracked) {
      entry.hits = entry.hits.filter(
        (hit) => timestampMs - hit.timestampMs <= this.config.evidenceWindowMs,
      );
      const next = incoming.get(pitchClass);
      if (next) {
        entry.hits.push({ timestampMs, note: next });
        const representative = strongestRepresentative(entry.hits);
        const maySwitchOctave =
          representative.midi === entry.note.midi ||
          hitCountForMidi(entry.hits, representative.midi) >= 3 ||
          entry.note.state === "candidate";
        const selected = maySwitchOctave ? representative : entry.note;
        const fastHits = entry.hits.filter(
          (hit) => timestampMs - hit.timestampMs <= this.config.fastAttackWindowMs,
        );
        const stronglySupported =
          fastHits.length >= this.config.fastAttackHits &&
          fastHits.some(
            (hit) => hit.note.confidence >= this.config.strongHitConfidence,
          );
        const weaklySupported = entry.hits.length >= this.config.weakAttackHits;
        const wasConfirmed = entry.note.state !== "candidate";
        const state: NoteLifecycle =
          wasConfirmed || stronglySupported || weaklySupported
            ? "active"
            : "candidate";
        entry.note = {
          ...selected,
          confidence: entry.note.confidence * 0.45 + next.confidence * 0.55,
          amplitude: entry.note.amplitude * 0.4 + next.amplitude * 0.6,
          state,
          firstSeenMs: entry.note.firstSeenMs,
          lastSeenMs: timestampMs,
          ageMs: timestampMs - entry.note.firstSeenMs,
        };
        incoming.delete(pitchClass);
        continue;
      }

      const missingMs = timestampMs - entry.note.lastSeenMs;
      if (
        (entry.note.state === "candidate" &&
          missingMs > this.config.evidenceWindowMs) ||
        (entry.note.state !== "candidate" && missingMs > this.config.releaseMs)
      ) {
        this.tracked.delete(pitchClass);
      } else if (entry.note.state !== "candidate") {
        entry.note = {
          ...entry.note,
          state: "releasing",
          confidence: entry.note.confidence * 0.9,
          amplitude: entry.note.amplitude * 0.88,
          ageMs: timestampMs - entry.note.firstSeenMs,
        };
      }
    }

    for (const note of incoming.values()) {
      this.tracked.set(note.pitchClass, {
        hits: [{ timestampMs, note }],
        note: {
          ...note,
          state: "candidate",
          firstSeenMs: timestampMs,
          lastSeenMs: timestampMs,
          ageMs: 0,
        },
      });
    }

    const ranked = [...this.tracked.entries()]
      .filter(([, entry]) => entry.note.state !== "candidate")
      .sort(([leftPitchClass, left], [rightPitchClass, right]) => {
        const leftObserved = observedNow.has(leftPitchClass) ? 1 : 0;
        const rightObserved = observedNow.has(rightPitchClass) ? 1 : 0;
        return (
          right.hits.length - left.hits.length ||
          rightObserved - leftObserved ||
          right.note.confidence - left.note.confidence ||
          right.note.lastSeenMs - left.note.lastSeenMs
        );
      });
    const limit = Number.isFinite(maximumNotes)
      ? Math.max(0, Math.floor(maximumNotes))
      : ranked.length;
    const selected = ranked.slice(0, limit);
    for (const [pitchClass] of ranked.slice(limit)) {
      this.tracked.delete(pitchClass);
    }

    return selected
      .map(([, entry]) => entry.note)
      .sort((left, right) => left.midi - right.midi);
  }
}
