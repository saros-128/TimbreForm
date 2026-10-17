import {useState,useMemo,useEffect,useRef,useCallback,type ChangeEvent} from 'react';
import {PhaseSceneScope,type PhaseGeometry} from './components/PhaseSceneScope';
import {FractalSceneScope} from './components/FractalSceneScope';
import {ImageMorphBackdrop,type ImageMorphMode,type ImageMorphSource} from './components/ImageMorphBackdrop';
import {SignalMeter} from './components/SignalMeter';
import type {FractalTravelMode} from './components/FractalFlightScope';
import type {SceneQuality} from './visuals/phaseSurface';
import type {LissajousScopeLayer} from './components/LissajousScope';
import {createAnalyzerConfig,useHarmonicAudio} from './hooks/useHarmonicAudio';
import {createPhasePortraitPoints,type LissajousPoint} from './audio/lissajous';
import {createNotePhaseLayers} from './audio/notePhaseLayers';
import {DEFAULT_AUDIO_INPUT_PROFILE,createLiveAnalyzerOverrides,type AudioInputProfileId,type LiveAnalysisProfileId} from './audio/profile';
import {noteName,pitchColor,type AccidentalMode} from './domain/music';
type PhaseDisplayMode='signal'|'notes'|'hybrid';type PhaseVisualPreset='classic'|'spatial';type LiveProfile=LiveAnalysisProfileId;type InputProfile=AudioInputProfileId;
interface PhaseVisualControls {
  detail: number;
  speed: number;
  lineWidth: number;
  blur: number;
  glow: number;
  opacity: number;
  phaseBrightness: number;
  trail: number;
  fractalBrightness: number;
  fractalZoom: number;
  fractalMorph: number;
  fractalDetailMotion: number;
  fractalDensity: number;
  fractalSymmetry: number;
  fractalSpeed: number;
  fractalSoundResponse: number;
  phaseDepth: number;
  phaseTilt: number;
  phaseRotation: number;
  phaseBend: number;
  phaseAxisDiversity: number;
  phaseLayerMotion: number;
  phaseLayerSoundResponse: number;
}

interface ImageMorphControls {
  mode: ImageMorphMode;
  transitionMs: number;
  changeRate: number;
  morph: number;
  opacity: number;
  brightness: number;
  phaseInfluence: number;
}

type PhaseVisualControlKey = keyof PhaseVisualControls;
const MAX_IMAGE_MORPH_SOURCES=16;
const DEFAULT_PHASE_VISUAL_CONTROLS: PhaseVisualControls = {
  detail: 100,
  speed: 100,
  lineWidth: 100,
  blur: 0,
  glow: 100,
  opacity: 100,
  phaseBrightness: 100,
  trail: 100,
  fractalBrightness: 100,
  fractalZoom: 50,
  fractalMorph: 85,
  fractalDetailMotion: 80,
  fractalDensity: 65,
  fractalSymmetry: 70,
  fractalSpeed: 100,
  fractalSoundResponse: 100,
  phaseDepth: 80,
  phaseTilt: 62,
  phaseRotation: 35,
  phaseBend: 65,
  phaseAxisDiversity: 0,
  phaseLayerMotion: 0,
  phaseLayerSoundResponse: 0,
};
const DEFAULT_SPATIAL_PHASE_VISUAL_CONTROLS: PhaseVisualControls = {
  ...DEFAULT_PHASE_VISUAL_CONTROLS,
  detail: 68,
  speed: 30,
  lineWidth: 130,
  glow: 115,
  opacity: 82,
  phaseBrightness: 120,
  trail: 35,
  phaseAxisDiversity: 75,
  phaseLayerMotion: 70,
  phaseLayerSoundResponse: 100,
};
const DEFAULT_IMAGE_MORPH_CONTROLS: ImageMorphControls = {
  mode: "beat",
  transitionMs: 1_400,
  changeRate: 100,
  morph: 80,
  opacity: 52,
  brightness: 100,
  phaseInfluence: 85,
};
interface ScopeAxes {
  x: Float32Array<ArrayBuffer>;
  y: Float32Array<ArrayBuffer>;
}
const EMPTY_SCOPE_AXES: ScopeAxes = {
  x: new Float32Array(),
  y: new Float32Array(),
};

interface VisualRangeControlProps {
  label: string;
  value: number;
  output?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function VisualRangeControl({
  label,
  value,
  output = `${value}%`,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  onChange,
}: VisualRangeControlProps) {
  return (
    <label className="phase-visual-range">
      <span>
        {label}
        <output>{output}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function splitScopePoints(points: readonly LissajousPoint[]): ScopeAxes {
  if (points.length === 0) return EMPTY_SCOPE_AXES;
  const x = new Float32Array(points.length);
  const y = new Float32Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    x[index] = points[index].x;
    y[index] = points[index].y;
  }
  return { x, y };
}
export function App(){
const captureMode="live";const showsPhasePortrait=true;
  const [liveProfile, setLiveProfile] = useState<LiveProfile>("stable");
  const [inputProfile, setInputProfile] = useState<InputProfile>(
    DEFAULT_AUDIO_INPUT_PROFILE,
  );

  const [phaseDisplayMode, setPhaseDisplayMode] =
    useState<PhaseDisplayMode>("hybrid");
  const [fractalEnabled, setFractalEnabled] = useState(false);
  const [phaseGeometry, setPhaseGeometry] = useState<PhaseGeometry>("lines");
  const [sceneQuality, setSceneQuality] = useState<SceneQuality>("auto");
  const [fractalMorphSeconds, setFractalMorphSeconds] = useState(3);
  const [imageMorphSources, setImageMorphSources] = useState<
    ImageMorphSource[]
  >([]);
  const imageMorphSourcesRef = useRef<ImageMorphSource[]>([]);
  const [imageMorphEnabled, setImageMorphEnabled] = useState(false);
  const [imageMorphControls, setImageMorphControls] =
    useState<ImageMorphControls>(() => ({ ...DEFAULT_IMAGE_MORPH_CONTROLS }));
  const [phaseControlsOpen, setPhaseControlsOpen] = useState(false);
  const [phaseFullscreen, setPhaseFullscreen] = useState(false);
  const [phaseFullscreenControlsVisible, setPhaseFullscreenControlsVisible] =
    useState(true);
  const [phaseVisualPreset, setPhaseVisualPreset] =
    useState<PhaseVisualPreset>("classic");
  const [phaseVisualControlsByPreset, setPhaseVisualControlsByPreset] =
    useState<Record<PhaseVisualPreset, PhaseVisualControls>>(() => ({
      classic: { ...DEFAULT_PHASE_VISUAL_CONTROLS },
      spatial: { ...DEFAULT_SPATIAL_PHASE_VISUAL_CONTROLS },
    }));
  const phaseVisualControls =
    phaseVisualControlsByPreset[phaseVisualPreset];
  const [fractalTravelModeByPreset, setFractalTravelModeByPreset] =
    useState<Record<PhaseVisualPreset, FractalTravelMode>>({
      classic: "approach",
      spatial: "approach",
    });
  const fractalTravelMode = fractalTravelModeByPreset[phaseVisualPreset];
const [maxPolyphony,setMaxPolyphony]=useState(4),[sensitivity,setSensitivity]=useState(50),[inputGain,setInputGain]=useState(1),[selectedDevice,setSelectedDevice]=useState('');const accidentalMode:AccidentalMode='sharp';
const phaseStageRef=useRef<HTMLDivElement>(null),phaseFullscreenIdleTimerRef=useRef<number|null>(null);
const analyzerConfig=useMemo(()=>createAnalyzerConfig(createLiveAnalyzerOverrides(liveProfile,maxPolyphony,sensitivity)),[liveProfile,maxPolyphony,sensitivity]);const audio=useHarmonicAudio(analyzerConfig,inputProfile);
useEffect(()=>audio.setGain(inputGain),[audio.setGain,inputGain]);
const startInput=()=>void audio.startMicrophone(selectedDevice||undefined);
const changeInputDevice=(id:string)=>{setSelectedDevice(id);if(audio.status==='running')void audio.startMicrophone(id||undefined);};
useEffect(()=>()=>{for(const source of imageMorphSourcesRef.current)URL.revokeObjectURL(source.url)},[]);
  const clearPhaseFullscreenIdleTimer = useCallback(() => {
    if (phaseFullscreenIdleTimerRef.current === null) return;
    window.clearTimeout(phaseFullscreenIdleTimerRef.current);
    phaseFullscreenIdleTimerRef.current = null;
  }, []);

  const schedulePhaseFullscreenControlsHide = useCallback(() => {
    clearPhaseFullscreenIdleTimer();
    if (!phaseFullscreen || phaseControlsOpen) return;
    phaseFullscreenIdleTimerRef.current = window.setTimeout(() => {
      setPhaseFullscreenControlsVisible(false);
      phaseFullscreenIdleTimerRef.current = null;
    }, 2_200);
  }, [clearPhaseFullscreenIdleTimer, phaseControlsOpen, phaseFullscreen]);

  const revealPhaseFullscreenControls = useCallback(() => {
    if (!phaseFullscreen) return;
    setPhaseFullscreenControlsVisible(true);
    schedulePhaseFullscreenControlsHide();
  }, [phaseFullscreen, schedulePhaseFullscreenControlsHide]);

  const enterPhaseFullscreen = useCallback(() => {
    const stage = phaseStageRef.current;
    if (!stage || typeof stage.requestFullscreen !== "function") return;
    void stage.requestFullscreen().catch(() => {
      setPhaseFullscreen(false);
      setPhaseFullscreenControlsVisible(true);
    });
  }, []);

  const exitPhaseFullscreen = useCallback(() => {
    if (
      document.fullscreenElement === phaseStageRef.current &&
      typeof document.exitFullscreen === "function"
    ) {
      void document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    const synchronizeFullscreenState = () => {
      const active = document.fullscreenElement === phaseStageRef.current;
      setPhaseFullscreen(active);
      setPhaseFullscreenControlsVisible(true);
    };
    document.addEventListener("fullscreenchange", synchronizeFullscreenState);
    return () => {
      document.removeEventListener(
        "fullscreenchange",
        synchronizeFullscreenState,
      );
    };
  }, []);

  useEffect(() => {
    clearPhaseFullscreenIdleTimer();
    setPhaseFullscreenControlsVisible(true);
    schedulePhaseFullscreenControlsHide();
    return clearPhaseFullscreenIdleTimer;
  }, [
    clearPhaseFullscreenIdleTimer,
    phaseControlsOpen,
    phaseFullscreen,
    schedulePhaseFullscreenControlsHide,
  ]);

  useEffect(() => {
    if (
      !showsPhasePortrait &&
      document.fullscreenElement === phaseStageRef.current &&
      typeof document.exitFullscreen === "function"
    ) {
      void document.exitFullscreen();
    }
  }, [showsPhasePortrait]);
  const setPhaseVisualControl = (key: PhaseVisualControlKey, value: number) => {
    const minimum = key === "lineWidth" ? 50 : key === "detail" ? 5 : 0;
    const maximum =
      key === "lineWidth"
        ? 500
        : key === "glow"
          ? 400
          : key === "phaseBrightness" || key === "fractalBrightness"
            ? 300
            : key === "phaseLayerMotion"
              ? 400
              : key === "fractalSpeed" ||
                  key === "fractalSoundResponse" ||
                  key === "phaseLayerSoundResponse"
                ? 200
                : 100;
    const normalized = Math.min(maximum, Math.max(minimum, Math.round(value)));
    setPhaseVisualControlsByPreset((current) => ({
      ...current,
      [phaseVisualPreset]: {
        ...current[phaseVisualPreset],
        [key]: normalized,
      },
    }));
  };
  const setFractalTravelMode = (mode: FractalTravelMode) => {
    setFractalTravelModeByPreset((current) => ({
      ...current,
      [phaseVisualPreset]: mode,
    }));
  };
  const resetPhaseVisualControls = () => {
    setPhaseVisualControlsByPreset((current) => ({
      ...current,
      [phaseVisualPreset]: {
        ...(phaseVisualPreset === "classic"
          ? DEFAULT_PHASE_VISUAL_CONTROLS
          : DEFAULT_SPATIAL_PHASE_VISUAL_CONTROLS),
      },
    }));
    setFractalTravelMode("approach");
  };
  const addImageMorphSources = (event: ChangeEvent<HTMLInputElement>) => {
    const availableSlots = Math.max(
      0,
      MAX_IMAGE_MORPH_SOURCES - imageMorphSourcesRef.current.length,
    );
    const files = Array.from(event.target.files ?? [])
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, availableSlots);
    event.target.value = "";
    if (files.length === 0) return;

    const timestamp = Date.now();
    const additions = files.map<ImageMorphSource>((file, index) => ({
      id:
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${timestamp}-${index}-${file.name}`,
      name: file.name,
      url: URL.createObjectURL(file),
    }));
    const next = [...imageMorphSourcesRef.current, ...additions];
    imageMorphSourcesRef.current = next;
    setImageMorphSources(next);
    setImageMorphEnabled(true);
  };
  const removeImageMorphSource = (id: string) => {
    const removed = imageMorphSourcesRef.current.find(
      (source) => source.id === id,
    );
    if (removed) URL.revokeObjectURL(removed.url);
    const next = imageMorphSourcesRef.current.filter(
      (source) => source.id !== id,
    );
    imageMorphSourcesRef.current = next;
    setImageMorphSources(next);
    if (next.length === 0) setImageMorphEnabled(false);
  };
  const clearImageMorphSources = () => {
    for (const source of imageMorphSourcesRef.current) {
      URL.revokeObjectURL(source.url);
    }
    imageMorphSourcesRef.current = [];
    setImageMorphSources([]);
    setImageMorphEnabled(false);
  };
  const setImageMorphControl = <Key extends keyof ImageMorphControls>(
    key: Key,
    value: ImageMorphControls[Key],
  ) => {
    setImageMorphControls((current) => ({ ...current, [key]: value }));
  };
  const startChordDemo=(midis:readonly number[])=>void audio.startDemo(midis);
const DEMO_CHORDS=[{label:"Em(maj7)",midis:[40,55,59,63]},{label:"F♯m7♭5",midis:[42,57,60,64]},{label:"Cmaj7",midis:[48,52,55,59]}];
const signalFrame = audio.frame;
  const phaseDetectedNotes =
    captureMode === "live" && liveProfile === "responsive"
      ? (signalFrame?.notes ?? [])
      : audio.trackedNotes;
  const phaseFrequency =
    audio.monophonicPitch?.note.frequency ??
    phaseDetectedNotes[0]?.frequency ??
    signalFrame?.notes[0]?.frequency ??
    null;
  const phaseAxes = useMemo(() => {
    if (
      !showsPhasePortrait ||
      !audio.waveform ||
      signalFrame?.gated !== false
    ) {
      return EMPTY_SCOPE_AXES;
    }
    return splitScopePoints(
      createPhasePortraitPoints(audio.waveform.samples, {
        sampleRate: audio.waveform.sampleRate,
        frequencyHz: phaseFrequency,
        maxPoints: 720,
      }),
    );
  }, [audio.waveform, phaseFrequency, showsPhasePortrait, signalFrame?.gated]);
  const notePhaseLayers = useMemo(() => {
    if (
      !showsPhasePortrait ||
      phaseDisplayMode === "signal" ||
      !audio.waveform ||
      signalFrame?.gated !== false
    ) {
      return [];
    }
    return createNotePhaseLayers(
      audio.waveform.samples,
      audio.waveform.sampleRate,
      phaseDetectedNotes,
      {
        maxNotes: maxPolyphony,
        maxHarmonics: 6,
        maxPoints: 480,
        minRelativeEnergy: 0.015,
      },
    );
  }, [
    audio.waveform,
    maxPolyphony,
    phaseDetectedNotes,
    phaseDisplayMode,
    showsPhasePortrait,
    signalFrame?.gated,
  ]);
  const coloredPhaseLayers = useMemo<LissajousScopeLayer[]>(
    () =>
      notePhaseLayers.map((layer) => {
        const axes = splitScopePoints(layer.points);
        return {
          ...axes,
          color: pitchColor(layer.pitchClass),
          pitchClass: layer.pitchClass,
          label: noteName(layer.pitchClass, accidentalMode),
          opacity: Math.min(0.9, 0.36 + layer.confidence * 0.52),
          lineWidth: 0.65 + layer.relativeEnergy * 0.5,
        };
      }),
    [accidentalMode, notePhaseLayers],
  );
  const phaseScopeAxes =
    phaseDisplayMode === "signal" ? phaseAxes : EMPTY_SCOPE_AXES;
  const phaseScopeLayers = useMemo<LissajousScopeLayer[]>(() => {
    if (phaseDisplayMode === "signal") return [];
    if (phaseDisplayMode === "notes" || phaseAxes.x.length < 2) {
      return coloredPhaseLayers;
    }
    return [
      {
        ...phaseAxes,
        color: "#7893a4",
        label: "mixed signal",
        opacity: 0.12,
        lineWidth: 0.65,
      },
      ...coloredPhaseLayers,
    ];
  }, [coloredPhaseLayers, phaseAxes, phaseDisplayMode]);
  const phaseLayerNames = coloredPhaseLayers
    .map((layer) => layer.label)
    .filter((label): label is string => Boolean(label));
  const imageMorphActive = imageMorphEnabled && imageMorphSources.length > 0;
  const phaseHasContent =
    fractalEnabled ||
    imageMorphActive ||
    (phaseDisplayMode === "notes"
      ? coloredPhaseLayers.length > 0
      : phaseAxes.x.length > 1 || coloredPhaseLayers.length > 0);
  const phaseLayerCount = coloredPhaseLayers.length;
  const phaseLayerUnit =
    phaseLayerCount === 1
      ? "LAYER"
      : phaseLayerCount >= 2 && phaseLayerCount <= 4
        ? "LAYERS"
        : "LAYERS";
  const phaseBaseMeta =
    phaseDisplayMode === "signal"
      ? phaseFrequency
        ? `${phaseFrequency.toFixed(1)} Hz`
        : "LIVE"
      : `${phaseLayerCount} ${phaseLayerUnit}`;
  const phasePresetMeta =
    phaseVisualPreset === "spatial" ? `3D · ${phaseBaseMeta}` : phaseBaseMeta;
  const phaseMeta =
    fractalEnabled && imageMorphActive
      ? `MIX · ${phasePresetMeta}`
      : fractalEnabled
        ? `FRACTAL · ${phasePresetMeta}`
        : imageMorphActive
          ? `IMAGES · ${phasePresetMeta}`
          : phasePresetMeta;
  const phaseTitle =
    fractalEnabled && imageMorphActive
      ? phaseVisualPreset === "spatial"
        ? "Fractal spatial media portrait"
        : "Fractal phase media portrait"
      : fractalEnabled
        ? phaseVisualPreset === "spatial"
          ? "Fractal spatial portrait"
          : "Fractal phase portrait"
        : imageMorphActive
          ? phaseVisualPreset === "spatial"
            ? "Spatial media portrait"
            : "Phase media portrait"
          : phaseVisualPreset === "spatial"
            ? "Spatial phase portrait"
            : "Phase portrait";
  const phaseBasePersistence =
    phaseDisplayMode === "signal"
      ? 0.82
      : phaseDisplayMode === "notes"
        ? 0.18
        : 0.34;
  const phasePersistence =
    phaseBasePersistence * (phaseVisualControls.trail / 100);
  const phaseSpeed = phaseVisualControls.speed / 100;
  const phaseSmoothingMs = 40 + (1 - phaseSpeed) * (1 - phaseSpeed) * 3_960;
  const phaseLineWidth = Math.max(0.5, phaseVisualControls.lineWidth / 100);
  const phaseDepth = (phaseVisualControls.phaseDepth / 100) * 1.5;
  const phaseTilt = (phaseVisualControls.phaseTilt - 50) / 50;
  const phaseRotation = (phaseVisualControls.phaseRotation / 100) * 2;
  const phaseBend = (phaseVisualControls.phaseBend / 100) * 1.5;
  const phaseAxisDiversity = phaseVisualControls.phaseAxisDiversity / 100;
  const phaseLayerMotion = phaseVisualControls.phaseLayerMotion / 100;
  const phaseLayerSoundResponse =
    phaseVisualControls.phaseLayerSoundResponse / 100;
  const phaseEnergy =
    signalFrame?.gated === false
      ? Math.min(1, Math.max(0, signalFrame.rms * 4))
      : 0;
  const fractalZoomOffset = (phaseVisualControls.fractalZoom - 50) / 50;
return <div className="app-shell phase-app"><header className="topbar"><div className="brand"><span><strong>TimbreForm</strong><small>Audio Visualizer</small></span></div>
        <div className="source-controls">
          <select
            aria-label="Input device"
            value={selectedDevice}
            onChange={(event) => changeInputDevice(event.target.value)}
            disabled={audio.status === "requesting"}
          >
            <option value="">System audio input</option>
            {audio.devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          {audio.status === "running" ? (
            <button className="button stop" onClick={() => void audio.stop()}>
              <span className="status-dot active" /> Stop
            </button>
          ) : (
            <button
              className="button primary"
              onClick={startInput}
              disabled={!audio.supported || audio.status === "requesting"}
            >
              <span className="status-dot" />
              {audio.status === "requesting" ? "Connecting…" : "Open input"}
            </button>
          )}
        </div>

        <SignalMeter
          rms={signalFrame?.rms ?? 0}
          inputPeakDb={signalFrame?.inputPeakDb ?? -120}
          noiseFloorDb={signalFrame?.noiseFloorDb ?? -120}
        />
      </header>

      {audio.error && <div className="error-banner">{audio.error}</div>}
<main><section className="control-strip" aria-label="Audio input"><label>Input processing <select aria-label="Input processing" value={inputProfile} onChange={e=>setInputProfile(e.target.value as InputProfile)}><option value="clean">Clean DI</option><option value="microphone">Microphone β</option></select></label>
<label>Live response <select aria-label="Live response" value={liveProfile} onChange={e=>setLiveProfile(e.target.value as LiveProfile)}><option value="stable">Stable</option><option value="responsive">Responsive β</option></select></label>
          <span className="strip-separator" />

          <label className="compact-field">
            Fundamentals
            <select
              value={maxPolyphony}
              onChange={(event) => setMaxPolyphony(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="range-field">
            Sensitivity
            <input
              type="range"
              min="10"
              max="90"
              value={sensitivity}
              onChange={(event) => setSensitivity(Number(event.target.value))}
            />
          </label>

          <label className="range-field gain-field">
            Gain
            <input
              type="range"
              min="0.25"
              max="3"
              step="0.05"
              value={inputGain}
              onChange={(event) => setInputGain(Number(event.target.value))}
            />
            <span>{inputGain.toFixed(2)}×</span>
          </label>

          <div className="demo-menu">
            <span>Demo</span>
            {DEMO_CHORDS.map((demo) => (
              <button key={demo.label} onClick={() => startChordDemo(demo.midis)}>
                {demo.label}
              </button>
            ))}

          </div>
</section><section className="visual-card"><div ref={phaseStageRef} className={'visual-stage is-scope phase-fullscreen-stage'+(phaseFullscreen?' is-phase-fullscreen':'')+(phaseFullscreen&&!phaseFullscreenControlsVisible?' phase-controls-idle':'')} data-phase-fullscreen={phaseFullscreen?'1':'0'} tabIndex={phaseFullscreen?0:undefined} onMouseMove={revealPhaseFullscreenControls} onPointerDown={revealPhaseFullscreenControls} onFocusCapture={revealPhaseFullscreenControls} onKeyDown={revealPhaseFullscreenControls}>
              {showsPhasePortrait && (
                <div className="visual-pane">
                  <div
                    className="phase-geometry-controls"
                    role="group"
                    aria-label="Scene geometry"
                  >
                    {(
                      [
                        ["lines", "Lines"],
                        ["cage", "Cage"],
                        ["surface", "Surface"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        aria-pressed={phaseGeometry === value}
                        onClick={() => setPhaseGeometry(value)}
                      >
                        {label}
                      </button>
                    ))}
                    <label>
                      Quality{" "}
                      <select
                        aria-label="Scene quality"
                        value={sceneQuality}
                        onChange={(e) =>
                          setSceneQuality(e.target.value as SceneQuality)
                        }
                      >
                        <option value="auto">Auto</option>
                        <option value="high">High</option>
                        <option value="economy">Economy</option>
                      </select>
                    </label>
                    {fractalEnabled && (
                      <label>
                        Shape transition{" "}
                        <input
                          aria-label="Shape transition time"
                          type="range"
                          min="0.3"
                          max="12"
                          step="0.1"
                          value={fractalMorphSeconds}
                          onChange={(e) => setFractalMorphSeconds(Number(e.target.value))}
                        />
                        {fractalMorphSeconds.toFixed(1)} s
                      </label>
                    )}
                  </div>
                  <PhaseSceneScope
                    geometry={phaseGeometry}
                    frameId={audio.waveform?.timestampMs}
                    quality={sceneQuality}
                    className="lissajous-shell"
                    x={phaseScopeAxes.x}
                    y={phaseScopeAxes.y}
                    layers={phaseScopeLayers}
                    mode="phase"
                    title={phaseTitle}
                    meta={phaseMeta}
                    phaseSourceMode={phaseDisplayMode}
                    phasePreset={phaseVisualPreset}
                    phaseDepth={phaseDepth}
                    phaseTilt={phaseTilt}
                    phaseRotation={phaseRotation}
                    phaseBend={phaseBend}
                    phaseAxisDiversity={phaseAxisDiversity}
                    phaseLayerMotion={phaseLayerMotion}
                    phaseLayerSoundResponse={phaseLayerSoundResponse}
                    phaseEnergy={phaseEnergy}
                    persistence={phasePersistence}
                    phaseDetail={phaseVisualControls.detail / 100}
                    phaseSpeed={phaseSpeed}
                    phaseLineWidth={phaseLineWidth}
                    phaseBlur={(phaseVisualControls.blur / 100) * 8}
                    phaseGlow={phaseVisualControls.glow / 100}
                    phaseOpacity={phaseVisualControls.opacity / 100}
                    phaseBrightness={
                      phaseVisualControls.phaseBrightness / 100
                    }
                    backgroundLayer={
                      fractalEnabled || imageMorphActive ? (
                        <div className="phase-backdrop-stack">
                          {fractalEnabled && (
                            <FractalSceneScope
                              quality={sceneQuality}
                              morphSeconds={fractalMorphSeconds}
                              backgroundOnly
                              x={phaseScopeAxes.x}
                              y={phaseScopeAxes.y}
                              layers={phaseScopeLayers}
                              notes={phaseDetectedNotes}
                              frameId={audio.waveform?.timestampMs}
                              intensity={
                                signalFrame?.gated === false
                                  ? signalFrame.rms
                                  : 0
                              }
                              fractalBrightness={
                                phaseVisualControls.fractalBrightness / 100
                              }
                              fractalZoomOffset={fractalZoomOffset}
                              fractalMorph={
                                phaseVisualControls.fractalMorph / 100
                              }
                              fractalDetailMotion={
                                phaseVisualControls.fractalDetailMotion / 100
                              }
                              fractalDensity={
                                phaseVisualControls.fractalDensity / 100
                              }
                              fractalSymmetry={
                                phaseVisualControls.fractalSymmetry / 100
                              }
                              fractalSpeed={
                                phaseVisualControls.fractalSpeed / 100
                              }
                              fractalTravelMode={fractalTravelMode}
                              fractalSoundResponse={
                                phaseVisualControls.fractalSoundResponse / 100
                              }
                            />
                          )}
                          {imageMorphActive && (
                            <ImageMorphBackdrop
                              sources={imageMorphSources}
                              enabled
                              mode={imageMorphControls.mode}
                              energy={phaseEnergy}
                              onsetSequence={audio.onsetPitch?.sequence ?? 0}
                              tempoBpm={null}
                              transitionMs={imageMorphControls.transitionMs}
                              changeRate={imageMorphControls.changeRate / 100}
                              morph={imageMorphControls.morph / 100}
                              opacity={imageMorphControls.opacity / 100}
                              brightness={imageMorphControls.brightness / 100}
                              phaseInfluence={
                                imageMorphControls.phaseInfluence / 100
                              }
                            />
                          )}
                        </div>
                      ) : undefined
                    }
                    ariaLabel={`${
                      phaseDisplayMode === "signal"
                        ? "Phase portrait of the mono input signal with a delayed copy on the Y axis"
                        : `${
                            phaseDisplayMode === "hybrid"
                              ? "Hybrid phase portrait of the mixed signal and"
                              : "Phase portrait"
                          } approximate spectral note layers: ${
                            phaseLayerNames.join(", ") || "no layers detected yet"
                          }`
                    }${
                      fractalEnabled
                        ? ". The fractal is a continuously evolving background"
                        : ""
                    }${
                      phaseVisualPreset === "spatial"
                        ? ". The spatial preset bends layers in three dimensions and moves them around independent axes"
                        : ""
                    }${
                      imageMorphActive
                        ? ". Uploaded images morph smoothly with audio rhythm and energy"
                        : ""
                    }`}
                  />
                </div>
              )}
{!phaseHasContent&&<div className="empty-overlay" role="status"><strong>{audio.status==='running'?'Waiting for signal':'Connect audio input'}</strong><span>Or start a demo</span></div>}
              {showsPhasePortrait && phaseFullscreen && (
                <div
                  className={`phase-fullscreen-controls${
                    phaseFullscreenControlsVisible || phaseControlsOpen
                      ? " is-visible"
                      : ""
                  }`}
                  role="toolbar"
                  aria-label="Fullscreen portrait controls"
                  aria-hidden={
                    !(phaseFullscreenControlsVisible || phaseControlsOpen)
                  }
                  inert={!(phaseFullscreenControlsVisible || phaseControlsOpen)}
                >
                  <button
                    type="button"
                    aria-label="Fullscreen portrait settings"
                    aria-expanded={phaseControlsOpen}
                    aria-controls="phase-visual-settings"
                    onClick={() => setPhaseControlsOpen((open) => !open)}
                  >
                    <span aria-hidden="true">⚙</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Exit fullscreen"
                    onClick={exitPhaseFullscreen}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              )}
              {showsPhasePortrait && phaseControlsOpen && (
                <section
                  id="phase-visual-settings"
                  className="phase-visual-settings"
                  aria-label="Visual settings"
                >
                  <div className="phase-visual-settings-heading">
                    <div>
                      <strong>Visual settings</strong>
                      <span>
                        {phaseVisualPreset === "classic"
                          ? "Classic preserves the current phase view"
                          : "Spatial mode has independent settings"}
                      </span>
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={resetPhaseVisualControls}
                        title="Reset only the active preset"
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => setPhaseControlsOpen(false)}
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <div
                    className="phase-preset-control is-settings"
                    role="group"
                    aria-label="Settings preset"
                  >
                    <button
                      type="button"
                      className={
                        phaseVisualPreset === "classic" ? "active" : ""
                      }
                      aria-pressed={phaseVisualPreset === "classic"}
                      onClick={() => setPhaseVisualPreset("classic")}
                    >
                      <strong>Classic</strong>
                      <span>Current flat portrait</span>
                    </button>
                    <button
                      type="button"
                      className={
                        phaseVisualPreset === "spatial" ? "active" : ""
                      }
                      aria-pressed={phaseVisualPreset === "spatial"}
                      onClick={() => setPhaseVisualPreset("spatial")}
                    >
                      <strong>Spatial</strong>
                      <span>Depth, independent axes and bend</span>
                    </button>
                  </div>

                  <div className="phase-visual-settings-grid">
                    <fieldset>
                      <legend>Phase</legend>
                      <VisualRangeControl
                        label="Phase detail"
                        value={phaseVisualControls.detail}
                        min={5}
                        onChange={(value) =>
                          setPhaseVisualControl("detail", value)
                        }
                      />
                      <VisualRangeControl
                        label="Phase speed"
                        value={phaseVisualControls.speed}
                        output={
                          phaseVisualControls.speed === 100
                            ? "realtime"
                            : `~${(phaseSmoothingMs / 1_000).toFixed(1)} s`
                        }
                        onChange={(value) =>
                          setPhaseVisualControl("speed", value)
                        }
                      />
                      <VisualRangeControl
                        label="Phase line width"
                        value={phaseVisualControls.lineWidth}
                        min={50}
                        max={500}
                        output={`${(
                          phaseVisualControls.lineWidth / 100
                        ).toFixed(2)}×`}
                        onChange={(value) =>
                          setPhaseVisualControl("lineWidth", value)
                        }
                      />
                      <VisualRangeControl
                        label="Phase blur"
                        value={phaseVisualControls.blur}
                        output={`${(
                          (phaseVisualControls.blur / 100) * 8
                        ).toFixed(1)} px`}
                        onChange={(value) =>
                          setPhaseVisualControl("blur", value)
                        }
                      />
                      <VisualRangeControl
                        label="Phase glow"
                        value={phaseVisualControls.glow}
                        max={400}
                        output={`${(phaseVisualControls.glow / 100).toFixed(
                          2,
                        )}×`}
                        onChange={(value) =>
                          setPhaseVisualControl("glow", value)
                        }
                      />
                      <VisualRangeControl
                        label="Phase opacity"
                        value={phaseVisualControls.opacity}
                        onChange={(value) =>
                          setPhaseVisualControl("opacity", value)
                        }
                      />
                      <VisualRangeControl
                        label="Phase brightness"
                        value={phaseVisualControls.phaseBrightness}
                        max={300}
                        output={`${(
                          phaseVisualControls.phaseBrightness / 100
                        ).toFixed(2)}×`}
                        onChange={(value) =>
                          setPhaseVisualControl("phaseBrightness", value)
                        }
                      />
                      <VisualRangeControl
                        label="Phase trail"
                        value={phaseVisualControls.trail}
                        onChange={(value) =>
                          setPhaseVisualControl("trail", value)
                        }
                      />
                      {phaseVisualPreset === "spatial" && (
                        <>
                          <VisualRangeControl
                            label="Spatial depth"
                            value={phaseVisualControls.phaseDepth}
                            output={`${phaseDepth.toFixed(2)}×`}
                            onChange={(value) =>
                              setPhaseVisualControl("phaseDepth", value)
                            }
                          />
                          <VisualRangeControl
                            label="Plane tilt"
                            value={phaseVisualControls.phaseTilt}
                            output={`${Math.round(phaseTilt * 60)}°`}
                            onChange={(value) =>
                              setPhaseVisualControl("phaseTilt", value)
                            }
                          />
                          <VisualRangeControl
                            label="Global scene rotation"
                            value={phaseVisualControls.phaseRotation}
                            output={`${phaseRotation.toFixed(2)}×`}
                            onChange={(value) =>
                              setPhaseVisualControl("phaseRotation", value)
                            }
                          />
                          <VisualRangeControl
                            label="Layer bend"
                            value={phaseVisualControls.phaseBend}
                            output={`${phaseBend.toFixed(2)}×`}
                            onChange={(value) =>
                              setPhaseVisualControl("phaseBend", value)
                            }
                          />
                          <VisualRangeControl
                            label="Axis spread"
                            value={phaseVisualControls.phaseAxisDiversity}
                            output={`${Math.round(phaseAxisDiversity * 100)}%`}
                            onChange={(value) =>
                              setPhaseVisualControl("phaseAxisDiversity", value)
                            }
                          />
                          <VisualRangeControl
                            label="Independent layer movement"
                            value={phaseVisualControls.phaseLayerMotion}
                            max={400}
                            output={`${phaseLayerMotion.toFixed(2)}×`}
                            onChange={(value) =>
                              setPhaseVisualControl("phaseLayerMotion", value)
                            }
                          />
                          <VisualRangeControl
                            label="Layer speed response"
                            value={phaseVisualControls.phaseLayerSoundResponse}
                            max={200}
                            output={`${phaseLayerSoundResponse.toFixed(2)}×`}
                            onChange={(value) =>
                              setPhaseVisualControl(
                                "phaseLayerSoundResponse",
                                value,
                              )
                            }
                          />
                        </>
                      )}
                    </fieldset>

                    <fieldset disabled={!fractalEnabled}>
                      <legend>
                        Fractal
                        {!fractalEnabled && <span>enable background</span>}
                      </legend>
                      <VisualRangeControl
                        label="Fractal brightness"
                        value={phaseVisualControls.fractalBrightness}
                        max={300}
                        output={`${(
                          phaseVisualControls.fractalBrightness / 100
                        ).toFixed(2)}×`}
                        onChange={(value) =>
                          setPhaseVisualControl("fractalBrightness", value)
                        }
                      />
                      <VisualRangeControl
                        label="Fractal zoom"
                        value={phaseVisualControls.fractalZoom}
                        output={
                          phaseVisualControls.fractalZoom === 50
                            ? "neutral"
                            : phaseVisualControls.fractalZoom > 50
                              ? `closer +${
                                  (phaseVisualControls.fractalZoom - 50) * 2
                                }%`
                              : `farther ${
                                  (50 - phaseVisualControls.fractalZoom) * 2
                                }%`
                        }
                        onChange={(value) =>
                          setPhaseVisualControl("fractalZoom", value)
                        }
                      />
                      <div
                        className="phase-fractal-travel-control"
                        role="group"
                        aria-label="Fractal movement"
                      >
                        <span>Fractal movement</span>
                        <div>
                          <button
                            type="button"
                            className={
                              fractalTravelMode === "approach" ? "active" : ""
                            }
                            aria-pressed={fractalTravelMode === "approach"}
                            onClick={() => setFractalTravelMode("approach")}
                          >
                            Approach
                          </button>
                          <button
                            type="button"
                            className={
                              fractalTravelMode === "recede" ? "active" : ""
                            }
                            aria-pressed={fractalTravelMode === "recede"}
                            onClick={() => setFractalTravelMode("recede")}
                          >
                            Recede
                          </button>
                          <button
                            type="button"
                            className={
                              fractalTravelMode === "pulse" ? "active" : ""
                            }
                            aria-pressed={fractalTravelMode === "pulse"}
                            onClick={() => setFractalTravelMode("pulse")}
                          >
                            Pulse
                          </button>
                        </div>
                      </div>
                      <VisualRangeControl
                        label="Fractal speed"
                        value={phaseVisualControls.fractalSpeed}
                        max={200}
                        output={`${(
                          phaseVisualControls.fractalSpeed / 100
                        ).toFixed(2)}×`}
                        onChange={(value) =>
                          setPhaseVisualControl("fractalSpeed", value)
                        }
                      />
                      <VisualRangeControl
                        label="Audio response"
                        value={phaseVisualControls.fractalSoundResponse}
                        max={200}
                        output={`${(
                          phaseVisualControls.fractalSoundResponse / 100
                        ).toFixed(2)}×`}
                        onChange={(value) =>
                          setPhaseVisualControl("fractalSoundResponse", value)
                        }
                      />
                      <VisualRangeControl
                        label="Shape morphing"
                        value={phaseVisualControls.fractalMorph}
                        onChange={(value) =>
                          setPhaseVisualControl("fractalMorph", value)
                        }
                      />
                      <VisualRangeControl
                        label="Detail pulsation"
                        value={phaseVisualControls.fractalDetailMotion}
                        onChange={(value) =>
                          setPhaseVisualControl("fractalDetailMotion", value)
                        }
                      />
                      <VisualRangeControl
                        label="Pattern density"
                        value={phaseVisualControls.fractalDensity}
                        onChange={(value) =>
                          setPhaseVisualControl("fractalDensity", value)
                        }
                      />
                      <VisualRangeControl
                        label="Radial symmetry"
                        value={phaseVisualControls.fractalSymmetry}
                        output={
                          phaseVisualControls.fractalSymmetry === 0
                            ? "off"
                            : `~${Math.round(
                                2 +
                                  phaseVisualControls.fractalSymmetry *
                                    0.08,
                              )} rays`
                        }
                        onChange={(value) =>
                          setPhaseVisualControl("fractalSymmetry", value)
                        }
                      />
                    </fieldset>

                    <fieldset className="phase-image-settings">
                      <legend>
                        Images
                        <span>{imageMorphSources.length} loaded</span>
                      </legend>
                      <div className="phase-image-actions">
                        <label
                          className={`phase-image-upload${
                            imageMorphSources.length >=
                            MAX_IMAGE_MORPH_SOURCES
                              ? " is-disabled"
                              : ""
                          }`}
                        >
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            disabled={
                              imageMorphSources.length >=
                              MAX_IMAGE_MORPH_SOURCES
                            }
                            aria-label="Upload images"
                            onChange={addImageMorphSources}
                          />
                          <span>
                            {imageMorphSources.length >=
                            MAX_IMAGE_MORPH_SOURCES
                              ? "16-file limit"
                              : "Add images"}
                          </span>
                        </label>
                        <label className="toggle phase-image-toggle">
                          <input
                            type="checkbox"
                            checked={imageMorphActive}
                            disabled={imageMorphSources.length === 0}
                            onChange={(event) =>
                              setImageMorphEnabled(event.target.checked)
                            }
                          />
                          <span /> Show
                        </label>
                        <button
                          type="button"
                          disabled={imageMorphSources.length === 0}
                          onClick={clearImageMorphSources}
                        >
                          Clear
                        </button>
                      </div>
                      <p className="phase-image-privacy">
                        Up to 16 files. They stay in this browser and are never uploaded.
                      </p>

                      {imageMorphSources.length > 0 && (
                        <div
                          className="phase-image-thumbnails"
                          aria-label="Uploaded images"
                        >
                          {imageMorphSources.map((source) => (
                            <figure key={source.id}>
                              <img src={source.url} alt="" />
                              <figcaption title={source.name}>
                                {source.name}
                              </figcaption>
                              <button
                                type="button"
                                aria-label={`Remove image ${source.name}`}
                                onClick={() =>
                                  removeImageMorphSource(source.id)
                                }
                              >
                                ×
                              </button>
                            </figure>
                          ))}
                        </div>
                      )}

                      <div
                        className="phase-fractal-travel-control phase-image-mode-control"
                        role="group"
                        aria-label="Image switching"
                      >
                        <span>Switch on</span>
                        <div>
                          {(
                            [
                              ["beat", "Beat"],
                              ["energy", "Energy"],
                              ["time", "Time"],
                            ] as const
                          ).map(([mode, label]) => (
                            <button
                              key={mode}
                              type="button"
                              disabled={imageMorphSources.length < 2}
                              className={
                                imageMorphControls.mode === mode ? "active" : ""
                              }
                              aria-pressed={imageMorphControls.mode === mode}
                              onClick={() => setImageMorphControl("mode", mode)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="phase-image-control-grid">
                        <VisualRangeControl
                          label="Transition duration"
                          value={imageMorphControls.transitionMs}
                          min={200}
                          max={5_000}
                          step={100}
                          disabled={imageMorphSources.length < 2}
                          output={`${(
                            imageMorphControls.transitionMs / 1_000
                          ).toFixed(1)} s`}
                          onChange={(value) =>
                            setImageMorphControl("transitionMs", value)
                          }
                        />
                        <VisualRangeControl
                          label="Change rate"
                          value={imageMorphControls.changeRate}
                          min={25}
                          max={300}
                          disabled={imageMorphSources.length < 2}
                          output={`${(
                            imageMorphControls.changeRate / 100
                          ).toFixed(2)}×`}
                          onChange={(value) =>
                            setImageMorphControl("changeRate", value)
                          }
                        />
                        <VisualRangeControl
                          label="Transition deformation"
                          value={imageMorphControls.morph}
                          max={200}
                          disabled={imageMorphSources.length === 0}
                          output={`${(imageMorphControls.morph / 100).toFixed(
                            2,
                          )}×`}
                          onChange={(value) =>
                            setImageMorphControl("morph", value)
                          }
                        />
                        <VisualRangeControl
                          label="Image opacity"
                          value={imageMorphControls.opacity}
                          disabled={imageMorphSources.length === 0}
                          onChange={(value) =>
                            setImageMorphControl("opacity", value)
                          }
                        />
                        <VisualRangeControl
                          label="Image brightness"
                          value={imageMorphControls.brightness}
                          max={300}
                          disabled={imageMorphSources.length === 0}
                          output={`${(
                            imageMorphControls.brightness / 100
                          ).toFixed(2)}×`}
                          onChange={(value) =>
                            setImageMorphControl("brightness", value)
                          }
                        />
                        <VisualRangeControl
                          label="Audio deformation response"
                          value={imageMorphControls.phaseInfluence}
                          max={200}
                          disabled={imageMorphSources.length === 0}
                          output={`${(
                            imageMorphControls.phaseInfluence / 100
                          ).toFixed(2)}×`}
                          onChange={(value) =>
                            setImageMorphControl("phaseInfluence", value)
                          }
                        />
                      </div>
                    </fieldset>
                  </div>
                </section>
              )}</div><div className="visual-footer">              {showsPhasePortrait && (
                <>
                  <div
                    className="phase-preset-control is-compact"
                    role="group"
                    aria-label="Phase portrait preset"
                  >
                    <button
                      type="button"
                      className={
                        phaseVisualPreset === "classic" ? "active" : ""
                      }
                      aria-pressed={phaseVisualPreset === "classic"}
                      onClick={() => setPhaseVisualPreset("classic")}
                    >
                      Classic
                    </button>
                    <button
                      type="button"
                      className={
                        phaseVisualPreset === "spatial" ? "active" : ""
                      }
                      aria-pressed={phaseVisualPreset === "spatial"}
                      onClick={() => setPhaseVisualPreset("spatial")}
                    >
                      Spatial
                    </button>
                  </div>
                  <div
                    className="phase-display-control"
                    role="group"
                    aria-label="Phase portrait layers"
                  >
                    <button
                      className={phaseDisplayMode === "signal" ? "active" : ""}
                      aria-pressed={phaseDisplayMode === "signal"}
                      onClick={() => setPhaseDisplayMode("signal")}
                    >
                      Sum
                    </button>
                    <button
                      className={phaseDisplayMode === "notes" ? "active" : ""}
                      aria-pressed={phaseDisplayMode === "notes"}
                      onClick={() => setPhaseDisplayMode("notes")}
                      title="Approximate spectral separation, not isolated physical strings"
                    >
                      Notes β
                    </button>
                    <button
                      className={phaseDisplayMode === "hybrid" ? "active" : ""}
                      aria-pressed={phaseDisplayMode === "hybrid"}
                      onClick={() => setPhaseDisplayMode("hybrid")}
                    >
                      Hybrid
                    </button>
                  </div>
                  <button
                    type="button"
                    className={`phase-fractal-toggle${fractalEnabled ? " active" : ""}`}
                    aria-pressed={fractalEnabled}
                    onClick={() => setFractalEnabled((enabled) => !enabled)}
                    title="Show a continuously evolving fractal behind the selected phase layers"
                  >
                    Fractal
                  </button>
                  <button
                    type="button"
                    className={`phase-image-toggle-button${
                      imageMorphActive ? " active" : ""
                    }`}
                    aria-pressed={imageMorphActive}
                    disabled={imageMorphSources.length === 0}
                    onClick={() =>
                      setImageMorphEnabled((enabled) => !enabled)
                    }
                    title={
                      imageMorphSources.length === 0
                        ? "Add images in settings"
                        : "Show morphing of uploaded images"
                    }
                  >
                    Images · {imageMorphSources.length}
                  </button>
                  <button
                    type="button"
                    className={`phase-settings-toggle${phaseControlsOpen ? " active" : ""}`}
                    aria-expanded={phaseControlsOpen}
                    aria-controls="phase-visual-settings"
                    onClick={() => setPhaseControlsOpen((open) => !open)}
                    title="Adjust density, movement and the balance between phase and fractal"
                  >
                    Settings
                  </button>
                  <button
                    type="button"
                    className="phase-fullscreen-toggle"
                    onClick={enterPhaseFullscreen}
                    title="Show the phase portrait in fullscreen"
                  >
                    Fullscreen
                  </button>
                  {phaseDisplayMode !== "signal" && (
                    <div
                      className="phase-note-legend"
                      aria-label="Colored note layers"
                    >
                      {notePhaseLayers.map((layer) => {
                        const layerColor = pitchColor(layer.pitchClass);
                        return (
                          <span
                            key={layer.pitchClass}
                            title={`${layer.frequency.toFixed(1)} Hz · ${layer.partialCount} partials${
                              layer.ambiguousPartials > 0
                                ? ` · ${layer.ambiguousPartials} shared`
                                : ""
                            }`}
                          >
                            <i
                              style={{
                                backgroundColor: layerColor,
                                color: layerColor,
                              }}
                            />
                            {noteName(layer.pitchClass, accidentalMode)}
                          </span>
                        );
                      })}
                      {notePhaseLayers.length === 0 && <span>waiting for notes</span>}
                    </div>
                  )}
                  {fractalEnabled || imageMorphActive ? (
                    <span
                      className="scope-method"
                      title="Phase, fractal and images keep independent detail controls and respond to the same audio stream"
                    >
                      {fractalEnabled && imageMorphActive
                        ? "phase + fractal + images"
                        : fractalEnabled
                          ? "phase + continuous fractal"
                          : "phase + image morphing"}
                    </span>
                  ) : (
                    <span
                      className="scope-method"
                      title="τ is one quarter of the detected fundamental period"
                    >
                      X=s(t) · Y=s(t−τ)
                    </span>
                  )}
                </>
              )}</div></section></main></div>;}