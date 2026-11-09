// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04).
import { CONFIG } from "@/shared/config";
import type { AnalyzerMsg, Lane } from "@/shared/types";
import { AutoGain } from "./autoGain";
import { PitchTracker, rms, SpectralFeatures } from "./features";
import { LaneAssigner } from "./lanes";
import { OnsetDetector } from "./onset";
import { NoteFilter } from "./postprocess";
import { LinearResampler } from "./resampler";
import { SampleRing, Stft } from "./stft";
import { SustainTracker } from "./sustain";

type Widen<T> = T extends number ? number : T;
/** Parâmetros do analisador (subconjunto do CONFIG, ajustável pela suíte 08). */
export type AnalyzerConfig = { -readonly [K in keyof typeof CONFIG]: Widen<(typeof CONFIG)[K]> };

export interface StreamAnalyzer {
  /** Bloco mono no SR de entrada; t0 = procTime da primeira amostra. */
  push(block: Float32Array, t0: number): AnalyzerMsg[];
  /** Descarta o estado e ignora amostras com procTime < `at`. Devolve `sustain-end` (se havia) e `reset-ack`. */
  reset(at: number): AnalyzerMsg[];
}

export function createStreamAnalyzer(
  inputSampleRate: number,
  cfg: AnalyzerConfig = CONFIG,
): StreamAnalyzer {
  return new Analyzer(inputSampleRate, cfg);
}

/** Centroide = mediana dos 5 quadros (~50ms) a partir do onset; pico de rms idem. */
const POST_ONSET_FRAMES = 5;
const FEATURE_RING = 64;
const FEATURE_MASK = FEATURE_RING - 1;

class Analyzer implements StreamAnalyzer {
  private readonly sr: number;
  private readonly n: number;
  private readonly hop: number;
  private readonly hopS: number;
  /** Atraso entre a amostra central de um quadro e o fim dele (s). */
  private readonly halfFrameS: number;
  private readonly lookahead: number;

  /** Normaliza o volume antes de tudo (etapa 0). Não é zerado no `reset`. */
  private readonly agc: AutoGain;
  private readonly stft: Stft;
  private readonly spectral: SpectralFeatures;
  private readonly pitch: PitchTracker;
  private readonly onsets: OnsetDetector;
  private readonly lanes: LaneAssigner;
  private readonly filter: NoteFilter;
  private readonly sustain: SustainTracker;

  private readonly ringSize: number;
  private resampler!: LinearResampler;
  private ring!: SampleRing;
  private readonly frame: Float32Array;
  private readonly pitchFrame: Float32Array;
  private readonly mag: Float64Array;
  private readonly centroids = new Float64Array(FEATURE_RING);
  private readonly rmsByFrame = new Float64Array(FEATURE_RING);
  private readonly cScratch = new Float64Array(POST_ONSET_FRAMES);

  /** procTime da amostra 0 do fluxo atual; null = fluxo ainda não começou. */
  private base: number | null = null;
  /** Amostras de entrada recebidas no fluxo atual (para detectar buracos). */
  private inputCount = 0;
  /** Quadros já calculados no fluxo atual. */
  private frames = 0;
  private ignoreBefore = -Infinity;
  private nextId = 1;

  constructor(
    private readonly inputRate: number,
    private readonly cfg: AnalyzerConfig,
  ) {
    this.sr = cfg.ANALYSIS_SR;
    this.n = cfg.FFT_SIZE;
    this.hop = cfg.HOP;
    this.hopS = this.hop / this.sr;
    this.halfFrameS = this.n / 2 / this.sr;
    // O quadro i só fica completo meia janela depois do seu centro; o lookahead
    // em quadros é o que sobra do orçamento ANALYSIS_LOOKAHEAD_S.
    this.lookahead = Math.max(
      POST_ONSET_FRAMES + 1,
      Math.floor((cfg.ANALYSIS_LOOKAHEAD_S - this.halfFrameS) / this.hopS),
    );

    this.agc = new AutoGain(inputRate, {
      targetRms: cfg.AGC_TARGET_RMS,
      tauS: cfg.AGC_TAU_S,
      maxGain: cfg.AGC_MAX_GAIN,
      silenceRms: cfg.AGC_SILENCE_RMS,
    });
    this.stft = new Stft(this.n);
    this.spectral = new SpectralFeatures(this.sr, this.n);
    this.pitch = new PitchTracker(this.sr, this.n);
    this.onsets = new OnsetDetector({
      pastFrames: Math.round(1 / this.hopS),
      lookahead: this.lookahead,
      peakRadius: 3,
      k: cfg.ONSET_K,
      deltaRatio: cfg.ONSET_DELTA_RATIO,
      minGapFrames: Math.round(cfg.ONSET_MIN_GAP_S / this.hopS),
    });
    this.lanes = new LaneAssigner(cfg.LANE_WINDOW_S);
    this.filter = new NoteFilter({
      blankAfterResetS: cfg.BLANK_AFTER_RESET_S,
      laneMinGapS: cfg.LANE_MIN_GAP_S,
      maxNotesPerS: cfg.MAX_NOTES_PER_S,
    });
    this.sustain = new SustainTracker({
      minS: cfg.SUSTAIN_MIN_S,
      energyRatio: cfg.SUSTAIN_ENERGY_RATIO,
      pitchToleranceSemitones: cfg.SUSTAIN_PITCH_TOLERANCE_SEMITONES,
      minClarity: cfg.SUSTAIN_MIN_CLARITY,
      extendIntervalS: cfg.SUSTAIN_EXTEND_INTERVAL_S,
      settleFrames: Math.ceil(this.n / 2 / this.hop),
    });
    this.frame = new Float32Array(this.n);
    this.pitchFrame = new Float32Array(this.n);
    this.mag = new Float64Array(this.stft.bins);

    // O ring guarda o quadro mais antigo ainda não decidido (pitch do sustain).
    let size = 1;
    while (size < this.n + (this.lookahead + 2) * this.hop) size *= 2;
    this.ringSize = size;
  }

  push(block: Float32Array, t0: number): AnalyzerMsg[] {
    const out: AnalyzerMsg[] = [];
    let input = block;
    let start = t0;
    if (t0 < this.ignoreBefore) {
      const skip = Math.ceil((this.ignoreBefore - t0) * this.inputRate - 1e-6);
      if (skip >= block.length) return out;
      input = block.subarray(skip);
      start = t0 + skip / this.inputRate;
    }

    // Buraco no fluxo (ex.: set-active false → true): recomeça como um início novo.
    if (this.base !== null) {
      const expected = this.base + this.inputCount / this.inputRate;
      if (Math.abs(start - expected) > 1.5 / this.inputRate) this.stop(out);
    }
    if (this.base === null) this.begin(start);

    const x = this.agc.process(input);
    this.inputCount += input.length;
    const y = this.resampler.process(x);
    this.ring.push(y);
    while (this.ring.count >= this.frames * this.hop + this.n) this.analyzeFrame(out);
    return out;
  }

  reset(at: number): AnalyzerMsg[] {
    const out: AnalyzerMsg[] = [];
    this.stop(out);
    this.ignoreBefore = at;
    out.push({ type: "reset-ack", at });
    return out;
  }

  private begin(start: number): void {
    this.base = start;
    this.inputCount = 0;
    this.frames = 0;
    this.resampler = new LinearResampler(this.inputRate, this.sr);
    this.ring = new SampleRing(this.ringSize);
    this.spectral.reset();
    this.onsets.reset();
    this.lanes.reset();
    this.filter.restart(start);
  }

  /** Encerra o fluxo atual (sustain ativo termina); o próximo push recomeça. */
  private stop(out: AnalyzerMsg[]): void {
    this.sustain.reset(out);
    this.base = null;
  }

  private frameTime(i: number): number {
    return this.base! + (i * this.hop + this.n / 2) / this.sr;
  }

  private analyzeFrame(out: AnalyzerMsg[]): void {
    const k = this.frames++;
    this.ring.read(k * this.hop, this.frame);
    this.stft.magnitude(this.frame, this.mag);
    this.centroids[k & FEATURE_MASK] = this.spectral.centroid(this.mag);
    this.rmsByFrame[k & FEATURE_MASK] = rms(this.frame);
    const flux = this.spectral.flux(this.mag);

    const d = this.onsets.push(flux);
    if (!d) return;
    const i = d.frame;
    const ti = this.frameTime(i);
    if (d.onset) this.onOnset(i, ti + d.offset * this.hopS, d.strength, out);
    this.sustain.onFrame(
      {
        index: i,
        time: ti,
        rms: this.rmsByFrame[i & FEATURE_MASK]!,
        pitch: () => {
          this.ring.read(i * this.hop, this.pitchFrame);
          return this.pitch.detect(this.pitchFrame);
        },
      },
      out,
    );
  }

  private onOnset(i: number, tPeak: number, strength: number, out: AnalyzerMsg[]): void {
    // Gate de energia: o fim de uma nota também gera flux positivo (vazamento espectral
    // da janela), mas derruba o rms. Compara as janelas inteiras antes e depois do pico.
    const half = Math.ceil(this.n / 2 / this.hop);
    if (i >= half) {
      const before = this.rmsByFrame[(i - half) & FEATURE_MASK]!;
      const after = this.rmsByFrame[(i + half) & FEATURE_MASK]!;
      if (after < this.cfg.ONSET_ENERGY_GATE * before) return;
    }

    const c = this.cScratch;
    let peak = 0;
    for (let j = 0; j < POST_ONSET_FRAMES; j++) {
      c[j] = this.centroids[(i + j) & FEATURE_MASK]!;
      peak = Math.max(peak, this.rmsByFrame[(i + j) & FEATURE_MASK]!);
    }
    c.sort();
    const centroid = c[POST_ONSET_FRAMES >> 1]!;

    const t = tPeak - this.cfg.ANALYZER_OFFSET_S;
    const choice = this.lanes.assign(t, centroid);
    const lane: Lane | null = this.filter.accept(t, choice.lane, choice.alt, strength);
    if (lane === null) return;
    this.lanes.noteEmitted(lane, centroid);
    const id = this.nextId++;
    out.push({ type: "note", id, t, lane, strength });
    this.sustain.onNote(id, lane, t, i, peak, out);
  }
}
