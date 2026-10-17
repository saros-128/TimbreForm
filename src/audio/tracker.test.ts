import { describe, expect, it } from "vitest";
import { NoteTracker } from "./tracker";
import type { DetectedNote } from "../domain/music";

const E3: DetectedNote = {
  midi: 52,
  pitchClass: 4,
  frequency: 164.81,
  cents: 0,
  confidence: 0.62,
  amplitude: 0.8,
};

function note(pitchClass: number, confidence = 0.62): DetectedNote {
  return {
    ...E3,
    midi: 48 + pitchClass,
    pitchClass,
    confidence,
  };
}

describe("NoteTracker", () => {
  it("activates two strong hits even with one missing frame between them", () => {
    const tracker = new NoteTracker();
    expect(tracker.update([E3], 0)).toEqual([]);
    expect(tracker.update([], 32)).toEqual([]);
    expect(tracker.update([E3], 64)[0]).toMatchObject({
      pitchClass: 4,
      state: "active",
    });
  });

  it("never activates a one-frame false note, regardless of confidence", () => {
    const tracker = new NoteTracker();
    expect(tracker.update([{ ...E3, confidence: 0.99 }], 0)).toEqual([]);
    expect(tracker.update([], 160)).toEqual([]);
    expect(tracker.update([], 161)).toEqual([]);
  });

  it("accepts three weaker hits inside the evidence window", () => {
    const tracker = new NoteTracker();
    const weak = { ...E3, confidence: 0.34 };
    expect(tracker.update([weak], 0)).toEqual([]);
    expect(tracker.update([weak], 64)).toEqual([]);
    expect(tracker.update([weak], 128)[0]).toMatchObject({ state: "active" });
  });

  it("holds a short dropout and removes the note after the bounded release", () => {
    const tracker = new NoteTracker();
    tracker.update([E3], 0);
    tracker.update([E3], 32);
    expect(tracker.update([], 192)[0]).toMatchObject({ state: "releasing" });
    expect(tracker.update([], 193)).toEqual([]);
  });

  it("does not let a two-frame extra note replace an established chord tone", () => {
    const tracker = new NoteTracker();
    const triad = [note(0), note(4), note(7)];
    for (const timestamp of [0, 32, 64, 96]) {
      tracker.update(triad, timestamp, 3);
    }

    const falseNote = note(6, 0.8);
    const noisyFrame = [note(4), falseNote, note(7)];
    tracker.update(noisyFrame, 128, 3);
    expect(
      tracker.update(noisyFrame, 160, 3).map((item) => item.pitchClass),
    ).toEqual([0, 4, 7]);
  });
});
