// Relógio do jogo (spec 02): converte performance.now() ↔ procTime (ctx.currentTime)
// e calcula gameTime, compensado pela latência de saída e por DELAY_S.
import { LatencySmoother, type AudioGraph } from "@/content/audioGraph";
import { CONFIG, type LatencySource } from "@/shared/config";
import { log } from "@/shared/log";

export interface GameClock {
  /** procTime estimado no instante perf (ms de performance.now / Event.timeStamp). */
  procTimeAt(perfMs: number): number;
  /** Tempo que está sendo ouvido no instante perf. */
  heardTimeAt(perfMs: number): number;
  /** heardTimeAt(perf) − DELAY_S. Base de todo o jogo. */
  gameTimeAt(perfMs: number): number;
  /** Atalho para gameTimeAt(performance.now()), monotônico não decrescente. */
  gameTime(): number;
  /** Latência total aplicada (s), para debug/HUD. */
  latency(): number;
  /** As duas fontes medidas (SPIKE 1), para debug/HUD. `null` = ainda sem medida. */
  latencySources(): { outputLatency: number; outputTimestamp: number | null };
  /** Descarta amostras (chamar após resume e após flush). */
  resync(): void;
  /** Chamado a cada rAF pelo loop do jogo. */
  sample(): void;
}

export interface ClockOptions {
  /** Relógio de perf (ms). Injetável para testes. */
  now?: () => number;
  /** Sobrescreve CONFIG.LATENCY_SOURCE (testes / SPIKE). */
  latencySource?: LatencySource;
  /** Debug: avisado a cada resync (manual, mudança de estado ou descontinuidade). */
  onResync?: (reason: "manual" | "state" | "outlier") => void;
}

type ClockGraph = Pick<AudioGraph, "ctx" | "getOutputLatency">;

/** Faixa aceita para uma medida crua da fonte B (descarta lixo do getOutputTimestamp). */
const MAX_SANE_LATENCY_S = 1;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Regressão linear procTime = a + b·(perf − x0) sobre uma janela deslizante de amostras.
 * `x0` (primeira amostra) evita perda de precisão com perf na casa de 1e6–1e9 ms.
 */
class PerfToProcFit {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private x0 = 0;
  private a = 0;
  private b = 0.001;

  get size(): number {
    return this.xs.length;
  }

  clear(): void {
    this.xs.length = 0;
    this.ys.length = 0;
  }

  lastPerf(): number | undefined {
    return this.xs[this.xs.length - 1];
  }

  push(perfMs: number, procS: number): void {
    if (this.xs.length === 0) this.x0 = perfMs;
    this.xs.push(perfMs - this.x0);
    this.ys.push(procS);
    if (this.xs.length > CONFIG.CLOCK_WINDOW) {
      this.xs.shift();
      this.ys.shift();
    }
    this.refit();
  }

  /** Requer size ≥ 1. */
  at(perfMs: number): number {
    const n = this.xs.length;
    const x = perfMs - this.x0;
    if (n < CONFIG.CLOCK_MIN_SAMPLES) return this.ys[n - 1]! + (x - this.xs[n - 1]!) / 1000;
    return this.a + this.b * x;
  }

  private refit(): void {
    const n = this.xs.length;
    if (n < CONFIG.CLOCK_MIN_SAMPLES) return;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += this.xs[i]!;
      my += this.ys[i]!;
    }
    mx /= n;
    my /= n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = this.xs[i]! - mx;
      sxx += dx * dx;
      sxy += dx * (this.ys[i]! - my);
    }
    const raw = sxx > 0 ? sxy / sxx : 0.001;
    // b em s de ctx por ms de perf.
    this.b = Math.min(CONFIG.CLOCK_SLOPE_MAX / 1000, Math.max(CONFIG.CLOCK_SLOPE_MIN / 1000, raw));
    this.a = my - this.b * mx;
  }
}

export function createClock(graph: ClockGraph, opts: ClockOptions = {}): GameClock {
  const ctx = graph.ctx;
  const now = opts.now ?? (() => performance.now());
  const source = opts.latencySource ?? CONFIG.LATENCY_SOURCE;

  const fit = new PerfToProcFit();
  let lastState: string = ctx.state;
  let lastGameTime = -Infinity;

  // Fonte B: mediana das medidas cruas recentes, com a mesma rampa de 5ms/s da fonte A.
  const tsRaw: number[] = [];
  const tsSmoother = new LatencySmoother();
  let tsReady = false;

  function procTimeAt(perfMs: number): number {
    // Suspensa/fechada: o relógio congela no último currentTime.
    if (ctx.state !== "running") return ctx.currentTime;
    if (fit.size === 0) return ctx.currentTime + (perfMs - now()) / 1000;
    return fit.at(perfMs);
  }

  function timestampLatency(): number | null {
    return tsReady ? tsSmoother.value(now()) : null;
  }

  function latency(): number {
    if (source === "output-timestamp") {
      // Até a primeira medida válida, usa a fonte A (nunca as duas somadas).
      return timestampLatency() ?? graph.getOutputLatency();
    }
    return graph.getOutputLatency();
  }

  function heardTimeAt(perfMs: number): number {
    return procTimeAt(perfMs) - latency();
  }

  function gameTimeAt(perfMs: number): number {
    return heardTimeAt(perfMs) - CONFIG.DELAY_S;
  }

  function resync(reason: "manual" | "state" | "outlier" = "manual"): void {
    fit.clear();
    opts.onResync?.(reason);
  }

  function measureTimestamp(perfMs: number): void {
    if (fit.size < CONFIG.CLOCK_MIN_SAMPLES || typeof ctx.getOutputTimestamp !== "function") return;
    const ts = ctx.getOutputTimestamp();
    const { contextTime, performanceTime } = ts;
    if (!contextTime || !performanceTime) return; // 0/undefined antes de a saída começar
    const raw = fit.at(performanceTime) - contextTime;
    if (!(raw >= 0 && raw <= MAX_SANE_LATENCY_S)) return;
    tsRaw.push(raw);
    if (tsRaw.length > CONFIG.CLOCK_WINDOW) tsRaw.shift();
    tsSmoother.setTarget(median(tsRaw), perfMs);
    tsReady = true;
  }

  function sample(): void {
    const perf = now();
    const state = ctx.state;
    if (state !== lastState) {
      lastState = state;
      resync("state");
    }
    if (state !== "running") return;
    if (perf === fit.lastPerf()) return; // dois sample() no mesmo frame

    const proc = ctx.currentTime;
    if (fit.size >= CONFIG.CLOCK_MIN_SAMPLES) {
      const err = proc - fit.at(perf);
      if (Math.abs(err) > CONFIG.CLOCK_OUTLIER_S) {
        log("relógio: descontinuidade, resync", { errMs: err * 1000 });
        resync("outlier");
      }
    }
    fit.push(perf, proc);
    measureTimestamp(perf);
  }

  function gameTime(): number {
    const t = gameTimeAt(now());
    // Correções pequenas da regressão não fazem o tempo voltar; uma grande (erro real) passa.
    if (t < lastGameTime && lastGameTime - t <= CONFIG.CLOCK_OUTLIER_S) return lastGameTime;
    lastGameTime = t;
    return t;
  }

  return {
    procTimeAt,
    heardTimeAt,
    gameTimeAt,
    gameTime,
    latency,
    latencySources: () => ({
      outputLatency: graph.getOutputLatency(),
      outputTimestamp: timestampLatency(),
    }),
    resync: () => resync(),
    sample,
  };
}
