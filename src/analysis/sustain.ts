// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04, etapa 6).
import type { AnalyzerMsg, Lane } from "@/shared/types";
import { semitones } from "./features";

export interface SustainConfig {
  minS: number;
  energyRatio: number;
  pitchToleranceSemitones: number;
  minClarity: number;
  extendIntervalS: number;
  /** Quadros após o onset antes de avaliar (janela já toda depois do ataque). */
  settleFrames: number;
}

/** Quadros seguidos com pitch fora da tolerância para encerrar o sustain. */
const PITCH_CHANGE_FRAMES = 3;

type State =
  | { kind: "idle" }
  | {
      kind: "candidate";
      id: number;
      lane: Lane;
      t: number;
      frame: number;
      peak: number;
      ref: number;
    }
  | {
      kind: "sustain";
      id: number;
      lane: Lane;
      peak: number;
      ref: number;
      bad: number;
      badSince: number;
      lastExtend: number;
    };

export interface FrameInfo {
  index: number;
  time: number;
  rms: number;
  /** Calculado só quando necessário (economia). */
  pitch: () => { pitch: number; clarity: number };
}

/** Máquina TAP → SUSTAIN → ENDED da nota mais recente (no máximo um sustain por vez). */
export class SustainTracker {
  private state: State = { kind: "idle" };
  private lastFrameTime = 0;

  constructor(private readonly cfg: SustainConfig) {}

  /** Encerra o sustain ativo (reset/descontinuidade) e volta ao repouso. */
  reset(out: AnalyzerMsg[]): void {
    if (this.state.kind === "sustain")
      out.push({ type: "sustain-end", id: this.state.id, end: this.lastFrameTime });
    this.state = { kind: "idle" };
  }

  /** Nota emitida no quadro `frame`; `peak` = rms máximo nos 50ms após o onset. */
  onNote(id: number, lane: Lane, t: number, frame: number, peak: number, out: AnalyzerMsg[]): void {
    const s = this.state;
    if (s.kind === "sustain") {
      if (s.lane !== lane) return; // outra pista: o sustain continua e a nova fica TAP
      out.push({ type: "sustain-end", id: s.id, end: t });
    }
    this.state = { kind: "candidate", id, lane, t, frame, peak, ref: 0 };
  }

  /** Avança um quadro (na mesma ordem das decisões de onset). */
  onFrame(f: FrameInfo, out: AnalyzerMsg[]): void {
    this.lastFrameTime = f.time;
    const s = this.state;
    const cfg = this.cfg;
    if (s.kind === "candidate") {
      if (f.index < s.frame + cfg.settleFrames) return;
      if (f.rms < cfg.energyRatio * s.peak) return this.idle();
      const { pitch, clarity } = f.pitch();
      if (clarity < cfg.minClarity || !(pitch > 0)) return this.idle();
      if (s.ref === 0) s.ref = pitch;
      else if (Math.abs(semitones(pitch, s.ref)) > cfg.pitchToleranceSemitones) return this.idle();
      if (f.time - s.t >= cfg.minS) {
        const until = s.t + cfg.minS;
        out.push({ type: "sustain-extend", id: s.id, until });
        this.state = {
          kind: "sustain",
          id: s.id,
          lane: s.lane,
          peak: s.peak,
          ref: s.ref,
          bad: 0,
          badSince: 0,
          lastExtend: until,
        };
      }
      return;
    }
    if (s.kind === "sustain") {
      if (f.rms < cfg.energyRatio * s.peak) return this.end(s.id, f.time, out);
      const { pitch, clarity } = f.pitch();
      const off =
        clarity < cfg.minClarity ||
        !(pitch > 0) ||
        Math.abs(semitones(pitch, s.ref)) > cfg.pitchToleranceSemitones;
      if (off) {
        if (s.bad++ === 0) s.badSince = f.time;
        if (s.bad >= PITCH_CHANGE_FRAMES) return this.end(s.id, s.badSince, out);
        return; // sem extend enquanto o pitch está fora: o fim fica em `badSince`
      }
      s.bad = 0;
      if (f.time - s.lastExtend >= cfg.extendIntervalS) {
        out.push({ type: "sustain-extend", id: s.id, until: f.time });
        s.lastExtend = f.time;
      }
    }
  }

  private idle(): void {
    this.state = { kind: "idle" };
  }

  private end(id: number, end: number, out: AnalyzerMsg[]): void {
    out.push({ type: "sustain-end", id, end });
    this.idle();
  }
}
