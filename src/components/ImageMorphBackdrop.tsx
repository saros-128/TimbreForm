import { useEffect, useRef } from "react";

export type ImageMorphMode = "beat" | "energy" | "time";

export interface ImageMorphSource {
  id: string;
  name: string;
  url: string;
}

interface ImageMorphBackdropProps {
  sources: readonly ImageMorphSource[];
  enabled: boolean;
  mode: ImageMorphMode;
  energy: number;
  onsetSequence: number;
  tempoBpm: number | null;
  transitionMs: number;
  changeRate: number;
  morph: number;
  opacity: number;
  brightness: number;
  phaseInfluence: number;
}

interface LoadedImage {
  source: ImageMorphSource;
  image: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

interface MorphFrame {
  current: HTMLImageElement;
  next: HTMLImageElement;
  progress: number;
  elapsedSeconds: number;
  energy: number;
  morph: number;
  opacity: number;
  brightness: number;
  phaseInfluence: number;
}

interface MorphRenderer {
  readonly kind: "webgl" | "canvas2d";
  render(frame: MorphFrame): void;
  prune?(activeImages: ReadonlySet<HTMLImageElement>): void;
  clear(): void;
  dispose(): void;
}

interface PlaybackState {
  currentId: string | null;
  nextId: string | null;
  transitionStartedAt: number;
  transitioning: boolean;
  lastChangeAt: number;
  lastOnsetSequence: number;
  lastOnsetAt: number;
  estimatedBeatMs: number | null;
  accumulatedOnsets: number;
  energyWasHigh: boolean;
  lastMode: ImageMorphMode;
}

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const MAX_TEXTURE_EDGE = 1_536;

const FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D u_current;
uniform sampler2D u_next;
uniform vec2 u_resolution;
uniform vec2 u_current_size;
uniform vec2 u_next_size;
uniform float u_progress;
uniform float u_time;
uniform float u_energy;
uniform float u_morph;
uniform float u_opacity;
uniform float u_brightness;
uniform float u_phase_influence;
varying vec2 v_uv;

const float PI = 3.141592653589793;

vec2 coverUv(vec2 uv, vec2 imageSize) {
  float viewportAspect = u_resolution.x / max(1.0, u_resolution.y);
  float imageAspect = imageSize.x / max(1.0, imageSize.y);
  if (imageAspect > viewportAspect) {
    uv.x = (uv.x - 0.5) * viewportAspect / imageAspect + 0.5;
  } else {
    uv.y = (uv.y - 0.5) * imageAspect / viewportAspect + 0.5;
  }
  return uv;
}

vec2 rotate2d(vec2 point, float angle) {
  float cosine = cos(angle);
  float sine = sin(angle);
  return mat2(cosine, -sine, sine, cosine) * point;
}

void main() {
  float blend = smoothstep(0.0, 1.0, u_progress);
  float transitionEnvelope = sin(blend * PI);
  vec2 centered = v_uv - 0.5;
  float radius = length(centered);
  float phaseMotion = u_phase_influence * (0.12 + u_energy * 0.42);
  float strength = u_morph * (0.018 + 0.082 * transitionEnvelope)
    + phaseMotion * 0.024;
  float ripple = sin(radius * (19.0 + u_phase_influence * 8.0)
    - u_time * (0.72 + u_energy * 1.65)
    + u_energy * 4.0);
  float twist = strength * (0.8 - radius) * (1.4 + ripple * 0.36);
  vec2 currentUv = rotate2d(centered, twist) + 0.5;
  vec2 nextUv = rotate2d(centered, -twist * 0.82) + 0.5;
  vec2 flow = vec2(
    sin((v_uv.y + u_time * 0.055) * 17.0 + u_energy * 3.0),
    cos((v_uv.x - u_time * 0.047) * 15.0 - u_energy * 2.0)
  ) * strength * (0.35 + transitionEnvelope);
  currentUv += flow * (0.35 + blend * 0.65);
  nextUv -= flow * (1.0 - blend * 0.55);

  vec4 currentColor = texture2D(
    u_current,
    clamp(coverUv(currentUv, u_current_size), 0.001, 0.999)
  );
  vec4 nextColor = texture2D(
    u_next,
    clamp(coverUv(nextUv, u_next_size), 0.001, 0.999)
  );
  vec4 color = mix(currentColor, nextColor, blend);
  float pulse = 1.0 + u_energy * 0.08 + transitionEnvelope * u_morph * 0.06;
  gl_FragColor = vec4(color.rgb * u_brightness * pulse, color.a * u_opacity);
}
`;

function clamp(value: number, minimum = 0, maximum = 1) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function imageWidth(image: HTMLImageElement) {
  return Math.max(1, image.naturalWidth || image.width || 1);
}

function imageHeight(image: HTMLImageElement) {
  return Math.max(1, image.naturalHeight || image.height || 1);
}

function textureUploadSource(
  image: HTMLImageElement,
  maximumEdge: number,
): TexImageSource {
  const width = imageWidth(image);
  const height = imageHeight(image);
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  if (scale >= 0.999) return image;

  const staging = document.createElement("canvas");
  staging.width = Math.max(1, Math.round(width * scale));
  staging.height = Math.max(1, Math.round(height * scale));
  const context = staging.getContext("2d", { alpha: false });
  if (!context) return image;
  context.drawImage(image, 0, 0, staging.width, staging.height);
  return staging;
}

function resizeCanvas(canvas: HTMLCanvasElement) {
  const bounds = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, bounds.width || canvas.clientWidth || 1);
  const cssHeight = Math.max(1, bounds.height || canvas.clientHeight || 1);
  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(cssWidth * pixelRatio));
  const height = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createWebGlRenderer(canvas: HTMLCanvasElement): MorphRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const highPrecision = gl.getShaderPrecisionFormat(
    gl.FRAGMENT_SHADER,
    gl.HIGH_FLOAT,
  );
  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    highPrecision && highPrecision.precision > 0
      ? FRAGMENT_SHADER
      : FRAGMENT_SHADER.replace(
          "precision highp float;",
          "precision mediump float;",
        ),
  );
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();
  const position = gl.getAttribLocation(program, "a_position");
  if (!buffer || position < 0) {
    if (buffer) gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(program);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniforms = {
    current: gl.getUniformLocation(program, "u_current"),
    next: gl.getUniformLocation(program, "u_next"),
    resolution: gl.getUniformLocation(program, "u_resolution"),
    currentSize: gl.getUniformLocation(program, "u_current_size"),
    nextSize: gl.getUniformLocation(program, "u_next_size"),
    progress: gl.getUniformLocation(program, "u_progress"),
    time: gl.getUniformLocation(program, "u_time"),
    energy: gl.getUniformLocation(program, "u_energy"),
    morph: gl.getUniformLocation(program, "u_morph"),
    opacity: gl.getUniformLocation(program, "u_opacity"),
    brightness: gl.getUniformLocation(program, "u_brightness"),
    phaseInfluence: gl.getUniformLocation(program, "u_phase_influence"),
  };
  const textures = new Map<HTMLImageElement, WebGLTexture>();
  const reportedTextureLimit = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const maximumTextureEdge = Math.max(
    1,
    Math.min(
      MAX_TEXTURE_EDGE,
      Number.isFinite(reportedTextureLimit)
        ? reportedTextureLimit
        : MAX_TEXTURE_EDGE,
    ),
  );

  const textureFor = (image: HTMLImageElement) => {
    const existing = textures.get(image);
    if (existing) return existing;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try {
      const uploadSource = textureUploadSource(image, maximumTextureEdge);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        uploadSource,
      );
    } catch {
      gl.deleteTexture(texture);
      return null;
    }
    textures.set(image, texture);
    return texture;
  };

  return {
    kind: "webgl",
    render(frame) {
      const currentTexture = textureFor(frame.current);
      const nextTexture = textureFor(frame.next);
      if (!currentTexture || !nextTexture) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, currentTexture);
      gl.uniform1i(uniforms.current, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, nextTexture);
      gl.uniform1i(uniforms.next, 1);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(
        uniforms.currentSize,
        imageWidth(frame.current),
        imageHeight(frame.current),
      );
      gl.uniform2f(
        uniforms.nextSize,
        imageWidth(frame.next),
        imageHeight(frame.next),
      );
      gl.uniform1f(uniforms.progress, frame.progress);
      gl.uniform1f(uniforms.time, frame.elapsedSeconds);
      gl.uniform1f(uniforms.energy, frame.energy);
      gl.uniform1f(uniforms.morph, frame.morph);
      gl.uniform1f(uniforms.opacity, frame.opacity);
      gl.uniform1f(uniforms.brightness, frame.brightness);
      gl.uniform1f(uniforms.phaseInfluence, frame.phaseInfluence);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    prune(activeImages) {
      textures.forEach((texture, image) => {
        if (activeImages.has(image)) return;
        gl.deleteTexture(texture);
        textures.delete(image);
      });
    },
    clear() {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    dispose() {
      textures.forEach((texture) => gl.deleteTexture(texture));
      textures.clear();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

interface CoverCrop {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

function coverCrop(
  image: HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
): CoverCrop {
  const width = imageWidth(image);
  const height = imageHeight(image);
  const imageAspect = width / height;
  const targetAspect = targetWidth / Math.max(1, targetHeight);
  if (imageAspect > targetAspect) {
    const sourceWidth = height * targetAspect;
    return {
      sourceX: (width - sourceWidth) / 2,
      sourceY: 0,
      sourceWidth,
      sourceHeight: height,
    };
  }
  const sourceHeight = width / targetAspect;
  return {
    sourceX: 0,
    sourceY: (height - sourceHeight) / 2,
    sourceWidth: width,
    sourceHeight,
  };
}

function drawWarpedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  alpha: number,
  direction: number,
  frame: MorphFrame,
) {
  if (alpha <= 0.001) return;
  const crop = coverCrop(image, canvas.width, canvas.height);
  const strips = 32;
  const destinationStripHeight = canvas.height / strips;
  const sourceStripHeight = crop.sourceHeight / strips;
  const transitionEnvelope = Math.sin(frame.progress * Math.PI);
  const strength =
    frame.morph * (0.012 + transitionEnvelope * 0.06) +
    frame.phaseInfluence * (0.005 + frame.energy * 0.018);

  context.save();
  context.globalAlpha = alpha * frame.opacity;
  context.filter = `brightness(${frame.brightness})`;
  for (let strip = 0; strip < strips; strip += 1) {
    const unitY = (strip + 0.5) / strips;
    const wave = Math.sin(
      unitY * Math.PI * (4.5 + frame.phaseInfluence * 2) +
        frame.elapsedSeconds * (0.55 + frame.energy * 1.25) +
        direction * frame.progress * 2.2,
    );
    const offset = wave * canvas.width * strength * direction;
    const stretch = 1 + Math.abs(wave) * strength * 0.65;
    context.drawImage(
      image,
      crop.sourceX,
      crop.sourceY + strip * sourceStripHeight,
      crop.sourceWidth,
      sourceStripHeight + 0.5,
      offset - (canvas.width * (stretch - 1)) / 2,
      strip * destinationStripHeight - 0.5,
      canvas.width * stretch,
      destinationStripHeight + 1,
    );
  }
  context.restore();
}

function createCanvasRenderer(canvas: HTMLCanvasElement): MorphRenderer | null {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return null;
  return {
    kind: "canvas2d",
    render(frame) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      const blend = frame.progress * frame.progress * (3 - 2 * frame.progress);
      drawWarpedImage(context, frame.current, canvas, 1 - blend, 1, frame);
      drawWarpedImage(context, frame.next, canvas, blend, -1, frame);
    },
    clear() {
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
    dispose() {
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

function setCanvasDiagnostic(
  canvas: HTMLCanvasElement,
  name: string,
  value: string | number | boolean,
) {
  canvas.dataset[name] = String(value);
}

function nextImage(
  loaded: readonly LoadedImage[],
  currentId: string | null,
) {
  if (loaded.length < 2) return null;
  const currentIndex = loaded.findIndex((entry) => entry.source.id === currentId);
  return loaded[(Math.max(0, currentIndex) + 1) % loaded.length] ?? null;
}

export function ImageMorphBackdrop({
  sources,
  enabled,
  mode,
  energy,
  onsetSequence,
  tempoBpm,
  transitionMs,
  changeRate,
  morph,
  opacity,
  brightness,
  phaseInfluence,
}: ImageMorphBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef(new Map<string, LoadedImage>());
  const sourcesRef = useRef(sources);
  const propsRef = useRef({
    mode,
    energy,
    onsetSequence,
    tempoBpm,
    transitionMs,
    changeRate,
    morph,
    opacity,
    brightness,
    phaseInfluence,
  });
  const playbackRef = useRef<PlaybackState>({
    currentId: null,
    nextId: null,
    transitionStartedAt: 0,
    transitioning: false,
    lastChangeAt: 0,
    lastOnsetSequence: onsetSequence,
    lastOnsetAt: 0,
    estimatedBeatMs: null,
    accumulatedOnsets: 0,
    energyWasHigh: false,
    lastMode: mode,
  });

  sourcesRef.current = sources;
  propsRef.current = {
    mode,
    energy,
    onsetSequence,
    tempoBpm,
    transitionMs,
    changeRate,
    morph,
    opacity,
    brightness,
    phaseInfluence,
  };

  useEffect(() => {
    const records = imagesRef.current;
    const wantedIds = new Set(sources.map((source) => source.id));
    records.forEach((record, id) => {
      const matchingSource = sources.find(
        (source) => source.id === id && source.url === record.source.url,
      );
      if (!wantedIds.has(id) || !matchingSource) {
        record.image.onload = null;
        record.image.onerror = null;
        records.delete(id);
      }
    });

    sources.forEach((source) => {
      if (records.has(source.id)) return;
      const image = new Image();
      image.decoding = "async";
      const record: LoadedImage = {
        source,
        image,
        ready: false,
        failed: false,
      };
      image.onload = () => {
        record.ready = true;
        record.failed = false;
      };
      image.onerror = () => {
        record.ready = false;
        record.failed = true;
      };
      records.set(source.id, record);
      image.src = source.url;
    });
  }, [sources]);

  useEffect(
    () => () => {
      imagesRef.current.forEach((record) => {
        record.image.onload = null;
        record.image.onerror = null;
      });
      imagesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const fallbackCanvas = fallbackCanvasRef.current;
    if (!canvas || !fallbackCanvas) return;
    if (!enabled) {
      // Resetting a canvas clears it without locking its context type. Acquiring a
      // 2D context here would make WebGL unavailable when the gallery is enabled.
      canvas.width = Math.max(1, canvas.width);
      fallbackCanvas.width = Math.max(1, fallbackCanvas.width);
      canvas.dataset.imageMorphState = "disabled";
      return;
    }

    resizeCanvas(canvas);
    let renderCanvas = canvas;
    let renderer = createWebGlRenderer(canvas);
    const useCanvasFallback = () => {
      renderer?.dispose();
      canvas.style.visibility = "hidden";
      fallbackCanvas.style.display = "block";
      resizeCanvas(fallbackCanvas);
      renderCanvas = fallbackCanvas;
      renderer = createCanvasRenderer(fallbackCanvas);
      setCanvasDiagnostic(
        canvas,
        "imageMorphRenderer",
        renderer?.kind ?? "none",
      );
    };
    if (!renderer) useCanvasFallback();
    setCanvasDiagnostic(canvas, "imageMorphRenderer", renderer?.kind ?? "none");
    let frameRequest = 0;
    let disposed = false;
    const startedAt = performance.now();
    const playback = playbackRef.current;
    playback.lastOnsetSequence = propsRef.current.onsetSequence;
    playback.lastMode = propsRef.current.mode;

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      useCanvasFallback();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);

    const loadedImages = () =>
      sourcesRef.current
        .map((source) => imagesRef.current.get(source.id))
        .filter((record): record is LoadedImage => Boolean(record?.ready));

    const beginTransition = (now: number, loaded: readonly LoadedImage[]) => {
      const candidate = nextImage(loaded, playback.currentId);
      if (!candidate) return false;
      playback.nextId = candidate.source.id;
      playback.transitionStartedAt = now;
      playback.transitioning = true;
      playback.lastChangeAt = now;
      playback.accumulatedOnsets = 0;
      return true;
    };

    const tick = (now: number) => {
      if (disposed) return;
      resizeCanvas(renderCanvas);
      const currentProps = propsRef.current;
      const loaded = loadedImages();
      renderer?.prune?.(
        new Set(loaded.map((entry) => entry.image)),
      );
      setCanvasDiagnostic(canvas, "imageMorphLoaded", loaded.length);
      setCanvasDiagnostic(canvas, "imageMorphTotal", sourcesRef.current.length);
      setCanvasDiagnostic(canvas, "imageMorphEnergy", clamp(currentProps.energy).toFixed(3));

      if (currentProps.mode !== playback.lastMode) {
        playback.lastMode = currentProps.mode;
        playback.accumulatedOnsets = 0;
        playback.energyWasHigh = false;
        playback.lastChangeAt = now;
      }

      if (
        !playback.currentId ||
        !loaded.some((entry) => entry.source.id === playback.currentId)
      ) {
        playback.currentId = loaded[0]?.source.id ?? null;
        playback.nextId = null;
        playback.transitioning = false;
        playback.lastChangeAt = now;
      }

      if (
        playback.transitioning &&
        !loaded.some((entry) => entry.source.id === playback.nextId)
      ) {
        const replacement = nextImage(loaded, playback.currentId);
        if (replacement) {
          playback.nextId = replacement.source.id;
          playback.transitionStartedAt = now;
        } else {
          playback.nextId = null;
          playback.transitioning = false;
        }
      }

      const safeTransitionMs = clamp(currentProps.transitionMs, 120, 12_000);
      let progress = 0;
      if (playback.transitioning) {
        progress = clamp((now - playback.transitionStartedAt) / safeTransitionMs);
        if (progress >= 1) {
          playback.currentId = playback.nextId;
          playback.nextId = null;
          playback.transitioning = false;
          playback.lastChangeAt = now;
          progress = 0;
        }
      }

      const rate = clamp(currentProps.changeRate, 0.1, 4);
      const onsetDifference = Math.max(
        0,
        currentProps.onsetSequence - playback.lastOnsetSequence,
      );
      playback.lastOnsetSequence = currentProps.onsetSequence;
      if (onsetDifference > 0) {
        if (playback.lastOnsetAt > 0) {
          const measuredBeatMs = clamp(
            (now - playback.lastOnsetAt) / Math.max(1, onsetDifference),
            180,
            2_000,
          );
          playback.estimatedBeatMs = playback.estimatedBeatMs === null
            ? measuredBeatMs
            : playback.estimatedBeatMs * 0.72 + measuredBeatMs * 0.28;
        }
        playback.lastOnsetAt = now;
      }
      const estimatedBpm = playback.estimatedBeatMs
        ? 60_000 / playback.estimatedBeatMs
        : 0;
      setCanvasDiagnostic(
        canvas,
        "imageMorphEstimatedBpm",
        estimatedBpm.toFixed(1),
      );
      if (!playback.transitioning && loaded.length > 1) {
        if (currentProps.mode === "beat") {
          playback.accumulatedOnsets += Math.min(8, onsetDifference);
          const beatsPerImage = Math.max(1, Math.round(4 / rate));
          const externalBeatMs = currentProps.tempoBpm === null
            ? null
            : 60_000 / clamp(currentProps.tempoBpm, 30, 260);
          const beatMs = externalBeatMs ?? playback.estimatedBeatMs;
          const tempoInterval = beatMs === null
            ? Number.POSITIVE_INFINITY
            : beatMs * beatsPerImage;
          const recentlyHeardBeat = playback.lastOnsetAt > 0 && beatMs !== null
            ? now - playback.lastOnsetAt <= Math.max(750, beatMs * 1.7)
            : false;
          const audibleTempo = clamp(currentProps.energy) > 0.035 &&
            (externalBeatMs !== null || recentlyHeardBeat);
          if (
            playback.accumulatedOnsets >= beatsPerImage ||
            (audibleTempo && now - playback.lastChangeAt >= tempoInterval)
          ) {
            beginTransition(now, loaded);
          }
        } else if (currentProps.mode === "energy") {
          const currentEnergy = clamp(currentProps.energy);
          const isHigh = currentEnergy >= 0.48;
          const energyInterval =
            (6_800 - currentEnergy * 5_200) / Math.max(0.2, rate);
          if (
            (isHigh && !playback.energyWasHigh && now - playback.lastChangeAt > 450) ||
            (currentEnergy > 0.16 && now - playback.lastChangeAt >= energyInterval)
          ) {
            beginTransition(now, loaded);
          }
          playback.energyWasHigh = isHigh;
        } else {
          const interval = 5_000 / rate;
          if (now - playback.lastChangeAt >= interval) {
            beginTransition(now, loaded);
          }
        }
      }

      const current = loaded.find(
        (entry) => entry.source.id === playback.currentId,
      );
      const next = loaded.find((entry) => entry.source.id === playback.nextId);
      setCanvasDiagnostic(canvas, "imageMorphCurrent", current?.source.id ?? "");
      setCanvasDiagnostic(canvas, "imageMorphNext", next?.source.id ?? "");
      setCanvasDiagnostic(canvas, "imageMorphTransitioning", playback.transitioning);
      setCanvasDiagnostic(canvas, "imageMorphProgress", progress.toFixed(3));
      canvas.dataset.imageMorphState =
        loaded.length === 0
          ? sourcesRef.current.length > 0
            ? "loading"
            : "empty"
          : playback.transitioning
            ? "transition"
            : "active";

      if (renderer && current) {
        renderer.render({
          current: current.image,
          next: next?.image ?? current.image,
          progress,
          elapsedSeconds: Math.max(0, now - startedAt) / 1_000,
          energy: clamp(currentProps.energy),
          morph: clamp(currentProps.morph, 0, 2),
          opacity: clamp(currentProps.opacity),
          brightness: clamp(currentProps.brightness, 0, 3),
          phaseInfluence: clamp(currentProps.phaseInfluence, 0, 2),
        });
      } else {
        renderer?.clear();
      }

      if (typeof window.requestAnimationFrame === "function") {
        frameRequest = window.requestAnimationFrame(tick);
      }
    };

    if (typeof window.requestAnimationFrame === "function") {
      frameRequest = window.requestAnimationFrame(tick);
    } else {
      tick(performance.now());
    }

    return () => {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      if (frameRequest && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frameRequest);
      }
      renderer?.dispose();
    };
  }, [enabled]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="image-morph-backdrop"
        aria-hidden="true"
        data-image-morph="true"
        data-image-morph-enabled={enabled ? "true" : "false"}
        data-image-morph-mode={mode}
        data-image-morph-source-count={sources.length}
        data-image-morph-change-rate={changeRate}
        data-image-morph-transition-ms={transitionMs}
        data-image-morph-morph={morph}
        data-image-morph-opacity={opacity}
        data-image-morph-brightness={brightness}
        data-image-morph-phase-influence={phaseInfluence}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: enabled ? "block" : "none",
          pointerEvents: "none",
          background: "transparent",
          mixBlendMode: "screen",
        }}
      />
      <canvas
        ref={fallbackCanvasRef}
        className="image-morph-backdrop-fallback"
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "none",
          pointerEvents: "none",
          background: "transparent",
          mixBlendMode: "screen",
        }}
      />
    </>
  );
}
