# DAW integration / VST plugin: multi-source phase visualization

**Status: Idea / Not scheduled**

## Concept

Explore a DAW integration or VST plugin that draws up to six independently routed audio sources as layers on one shared phase canvas. Each source produces a contour from its own signal; those contours are then overlaid visually. The sources are not summed into a single audio signal before their contours are computed.

A source could be an individual track or a group/bus, carrying a single note, a chord, percussion or another signal. Use **Sources** or **Layers** for these routed signals. They are distinct from **Fundamentals**, which refers to estimated fundamental tones within one signal. A source slot does not imply one detected note or one physical instrument.

## Visual direction

Keep one shared phase portrait to preserve the user's focus. A grid of separate visualization panels has been set aside for now.

Possible controls for each source slot:

- Source name.
- Color.
- Visibility.
- Visual intensity.

Starting with two or three active slots is a suggestion for discussion, not a decided default. Up to six sources is a product idea to investigate, not a guarantee of six-input support in every DAW.

## Open questions, not decisions

- Should the integration use sender instances on tracks, a multi-input visualization plugin, or another routing approach?
- What routing is actually possible in different DAWs, including Ableton Live? Which plugin formats, host configurations and track/group arrangements would be required?
- How should source streams be synchronized, including latency differences and transport behavior?
- What CPU/GPU load, buffering and visual frame rate are practical as the active source count increases?
- How should stereo sources be represented: separate channels, a combined interpretation or another explicit mode?
- Should an optional mix mode be offered, and how would it remain clearly distinct from overlaying independently computed source contours?
- Should pitch decomposition be available within a source, separately from the source-routing model?

## Scope and next decision

This document records an idea only. No implementation, prototype, issue, schedule or delivery commitment is implied. Technical feasibility and host support remain unverified. Turning this idea into development tasks requires a separate explicit decision.
