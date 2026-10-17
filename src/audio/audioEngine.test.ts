import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./audioEngine";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeAudioParam {
  value = 0;
  setTargetAtTime(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number) {
    this.value = value;
  }
  exponentialRampToValueAtTime(value: number) {
    this.value = value;
  }
}

class FakeNode {
  connections: FakeNode[] = [];
  connect(destination?: FakeNode) {
    if (destination) this.connections.push(destination);
    return destination ?? this;
  }
  disconnect() {
    this.connections = [];
  }
}

class FakeGainNode extends FakeNode {
  gain = new FakeAudioParam();
}

class FakeAnalyserNode extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  minDecibels = -100;
  maxDecibels = -30;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getFloatFrequencyData() {}
  getFloatTimeDomainData() {}
}

class FakeBiquadFilterNode extends FakeNode {
  type: BiquadFilterType = "lowpass";
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("AudioEngine lifecycle", () => {
  it("stops a microphone and closes a graph even while resume is pending", async () => {
    const resumeGate = deferred();
    const contexts: Array<{
      state: AudioContextState;
      gains: FakeGainNode[];
      close: ReturnType<typeof vi.fn>;
    }> = [];

    class FakeAudioContext {
      sampleRate = 48_000;
      currentTime = 0;
      state: AudioContextState = "suspended";
      destination = new FakeNode();
      gains: FakeGainNode[] = [];
      close = vi.fn(async () => {
        this.state = "closed";
      });
      resume = vi.fn(async () => {
        await resumeGate.promise;
        if (this.state !== "closed") this.state = "running";
      });

      constructor(options?: AudioContextOptions) {
        expect(options?.sampleRate).toBe(48_000);
        contexts.push(this);
      }

      createAnalyser() {
        return new FakeAnalyserNode();
      }
      createGain() {
        const gain = new FakeGainNode();
        this.gains.push(gain);
        return gain;
      }
      createBiquadFilter() {
        return new FakeBiquadFilterNode();
      }
      createMediaStreamSource() {
        return new FakeNode();
      }
    }

    const track = {
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
        enumerateDevices: vi.fn(async () => []),
      },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const engine = new AudioEngine();
    engine.setGain(1.75);
    const starting = engine.startMicrophone();
    await vi.waitFor(() => expect(contexts).toHaveLength(1));

    await engine.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(contexts[0].gains[0].gain.value).toBe(1.75);

    resumeGate.resolve();
    await expect(starting).resolves.toBe(false);
  });

  it("switches microphone processing without reopening the input stream", async () => {
    const contexts: Array<{
      state: AudioContextState;
      gains: FakeGainNode[];
      highpasses: FakeBiquadFilterNode[];
      close: ReturnType<typeof vi.fn>;
    }> = [];

    class FakeAudioContext {
      sampleRate = 48_000;
      currentTime = 0;
      state: AudioContextState = "suspended";
      destination = new FakeNode();
      gains: FakeGainNode[] = [];
      highpasses: FakeBiquadFilterNode[] = [];
      close = vi.fn(async () => {
        this.state = "closed";
      });
      resume = vi.fn(async () => {
        this.state = "running";
      });

      constructor() {
        contexts.push(this);
      }

      createAnalyser() {
        return new FakeAnalyserNode();
      }
      createGain() {
        const gain = new FakeGainNode();
        this.gains.push(gain);
        return gain;
      }
      createBiquadFilter() {
        const filter = new FakeBiquadFilterNode();
        this.highpasses.push(filter);
        return filter;
      }
      createMediaStreamSource() {
        return new FakeNode();
      }
    }

    const track = {
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const engine = new AudioEngine();
    await expect(engine.startMicrophone("interface-input")).resolves.toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: "interface-input" },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });
    expect(contexts[0].gains[0].connections[0]).toBeInstanceOf(FakeAnalyserNode);

    engine.setInputProfile("microphone");

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    expect(contexts[0].close).not.toHaveBeenCalled();
    expect(contexts[0].highpasses[0].type).toBe("highpass");
    expect(contexts[0].highpasses[0].frequency.value).toBe(52);
    expect(contexts[0].gains[0].connections).toEqual([contexts[0].highpasses[0]]);
    expect(contexts[0].highpasses[0].connections[0]).toBeInstanceOf(FakeAnalyserNode);

    await engine.stop();
  });
});
