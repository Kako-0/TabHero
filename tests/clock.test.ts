import { describe, expect, it } from "vitest";
import type { AudioGraph } from "@/content/audioGraph";
import { createClock, type ClockOptions } from "@/content/clock";
import { CONFIG } from "@/shared/config";

const QUANTUM_S = 128 / 48000;

/** Simula uma ctx cujo currentTime anda em quanta de 128 amostras, com relógio de perf controlado. */
class Sim {
  perf = 1_000_000; // ms; valor alto de propósito (precisão numérica)
  /** procTime "verdadeiro" (contínuo). */
  proc = 5;
  state: AudioContextState = "running";
  outputLatency = 0.02;
  baseLatency = 0.005;
  /** Latência "real" usada pelo getOutputTimestamp. */
  tsLatency = 0.04;
  /** Deriva do relógio de áudio em relação ao de perf (ex.: 1.0002). */
  rate = 1;
  private seed = 1;

  readonly ctx = {
    get state() {
      return sim.state;
    },
    get currentTime() {
      return Math.floor(sim.proc / QUANTUM_S) * QUANTUM_S;
    },
    getOutputTimestamp: () => ({
      contextTime: this.proc - this.tsLatency,
      performanceTime: this.perf,
    }),
  };

  readonly graph = {
    ctx: this.ctx as unknown as AudioContext,
    getOutputLatency: () => this.outputLatency + this.baseLatency,
  } satisfies Pick<AudioGraph, "ctx" | "getOutputLatency">;

  /** Ruído determinístico em [-1, 1]. */
  rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed / 2147483647) * 2 - 1;
  }

  advance(ms: number): void {
    this.perf += ms;
    if (this.state === "running") this.proc += (ms / 1000) * this.rate;
  }

  clock(opts: ClockOptions = {}) {
    return createClock(this.graph, { now: () => this.perf, ...opts });
  }
}

let sim: Sim;
function newSim(): Sim {
  sim = new Sim();
  return sim;
}

/** Roda n frames de ~16.7ms com jitter de ±jitterMs. */
function frames(s: Sim, n: number, fn: () => void, jitterMs = 2): void {
  for (let i = 0; i < n; i++) {
    s.advance(1000 / 60 + s.rand() * jitterMs);
    fn();
  }
}

describe("mapeamento perf → procTime", () => {
  it("menos de 10 amostras: última amostra + Δperf", () => {
    const s = newSim();
    const c = s.clock();
    c.sample();
    const t0 = s.ctx.currentTime;
    expect(c.procTimeAt(s.perf + 100)).toBeCloseTo(t0 + 0.1, 9);
  });

  it("sem amostras: currentTime + Δperf até agora", () => {
    const s = newSim();
    const c = s.clock();
    expect(c.procTimeAt(s.perf)).toBe(s.ctx.currentTime);
    expect(c.procTimeAt(s.perf - 50)).toBeCloseTo(s.ctx.currentTime - 0.05, 9);
  });

  it("com jitter: desvio médio vs currentTime < 3ms (10s) e erro vs proc real < 2ms", () => {
    const s = newSim();
    const c = s.clock();
    let sumDev = 0;
    let maxTrueErr = 0;
    let n = 0;
    frames(s, 600, () => {
      c.sample();
      if (n++ < CONFIG.CLOCK_MIN_SAMPLES) return;
      sumDev += Math.abs(c.procTimeAt(s.perf) - s.ctx.currentTime);
      maxTrueErr = Math.max(maxTrueErr, Math.abs(c.procTimeAt(s.perf) - s.proc));
    });
    expect(sumDev / (n - CONFIG.CLOCK_MIN_SAMPLES)).toBeLessThan(0.003);
    expect(maxTrueErr).toBeLessThan(0.002);
  });

  it("acompanha deriva dentro da faixa e trava a inclinação fora dela", () => {
    const s = newSim();
    s.rate = 1.0005;
    const c = s.clock();
    frames(s, 120, () => c.sample());
    const p0 = s.perf;
    // Quantização de 128 amostras em 1s de janela: inclinação estimada ± ~0,03%.
    expect(Math.abs(c.procTimeAt(p0 + 1000) - c.procTimeAt(p0) - 1.0005)).toBeLessThan(0.0004);

    const s2 = newSim();
    s2.rate = 1.01;
    const c2 = s2.clock();
    frames(s2, 120, () => c2.sample(), 0);
    expect(c2.procTimeAt(s2.perf + 1000) - c2.procTimeAt(s2.perf)).toBeCloseTo(
      CONFIG.CLOCK_SLOPE_MAX,
      6,
    );
  });

  it("dois sample() no mesmo frame não duplicam a amostra", () => {
    const s = newSim();
    const c = s.clock();
    frames(s, 20, () => {
      c.sample();
      c.sample();
    });
    expect(Math.abs(c.procTimeAt(s.perf) - s.proc)).toBeLessThan(0.003);
  });
});

describe("gameTime", () => {
  it("= procTime − latência − DELAY_S", () => {
    const s = newSim();
    const c = s.clock();
    frames(s, 30, () => c.sample());
    expect(c.latency()).toBeCloseTo(0.025, 9);
    expect(c.heardTimeAt(s.perf)).toBeCloseTo(c.procTimeAt(s.perf) - 0.025, 9);
    expect(c.gameTimeAt(s.perf)).toBeCloseTo(c.procTimeAt(s.perf) - 0.025 - CONFIG.DELAY_S, 9);
  });

  it("monotônico não decrescente, sem saltos > 5ms além do Δ do frame", () => {
    const s = newSim();
    const c = s.clock();
    let prev = -Infinity;
    let prevPerf = s.perf;
    frames(
      s,
      600,
      () => {
        c.sample();
        const t = c.gameTime();
        if (prev !== -Infinity) {
          expect(t).toBeGreaterThanOrEqual(prev);
          const expected = (s.perf - prevPerf) / 1000;
          expect(Math.abs(t - prev - expected)).toBeLessThan(0.005);
        }
        prev = t;
        prevPerf = s.perf;
      },
      4,
    );
  });

  it("ctx suspensa: congela; após o resume continua do mesmo valor (± 5ms)", () => {
    const s = newSim();
    const c = s.clock();
    frames(s, 60, () => c.sample());
    const before = c.gameTime();

    s.state = "suspended";
    c.sample();
    const frozen = c.gameTime();
    expect(Math.abs(frozen - before)).toBeLessThan(0.005);
    frames(s, 120, () => {
      c.sample();
      expect(c.gameTime()).toBe(frozen);
      // Eventos durante o pause também (gameTimeAt não tem a trava monotônica: ± 1 quantum).
      expect(Math.abs(c.gameTimeAt(s.perf - 500) - frozen)).toBeLessThan(QUANTUM_S);
    });

    s.state = "running";
    s.advance(1000 / 60);
    c.sample();
    expect(Math.abs(c.gameTime() - frozen)).toBeLessThan(0.005 + 1 / 60);
    let prev = c.gameTime();
    frames(s, 60, () => {
      c.sample();
      const t = c.gameTime();
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    });
    expect(Math.abs(c.procTimeAt(s.perf) - s.proc)).toBeLessThan(0.003);
  });
});

describe("resync", () => {
  it("descarta as amostras: volta ao modo 'última amostra + Δperf'", () => {
    const s = newSim();
    const c = s.clock();
    frames(s, 60, () => c.sample());
    c.resync();
    s.advance(16);
    c.sample();
    const t = s.ctx.currentTime;
    expect(c.procTimeAt(s.perf + 10)).toBeCloseTo(t + 0.01, 9);
  });

  it("mudança de state força resync", () => {
    const s = newSim();
    const c = s.clock();
    frames(s, 60, () => c.sample());
    s.state = "suspended";
    c.sample();
    s.state = "running";
    s.proc += 0.3; // salto qualquer: deve ser aceito sem herdar a reta antiga
    s.advance(16);
    c.sample();
    expect(c.procTimeAt(s.perf)).toBeCloseTo(s.ctx.currentTime, 9);
  });

  it("descontinuidade grande (> CLOCK_OUTLIER_S) reinicia a regressão", () => {
    const s = newSim();
    const c = s.clock();
    frames(s, 60, () => c.sample());
    s.proc += 0.2; // ex.: troca de dispositivo de saída
    frames(s, 2, () => c.sample(), 0);
    expect(Math.abs(c.procTimeAt(s.perf) - s.proc)).toBeLessThan(0.003);
  });
});

describe("latência (SPIKE 1)", () => {
  it("fonte A: outputLatency + baseLatency (via grafo)", () => {
    const s = newSim();
    const c = s.clock({ latencySource: "output-latency" });
    frames(s, 30, () => c.sample());
    expect(c.latency()).toBeCloseTo(0.025, 9);
  });

  it("fonte B: procTimeAt(performanceTime) − contextTime; usa A até ter medida", () => {
    const s = newSim();
    const c = s.clock({ latencySource: "output-timestamp" });
    c.sample();
    expect(c.latency()).toBeCloseTo(0.025, 9); // ainda sem medida B
    expect(c.latencySources().outputTimestamp).toBeNull();
    frames(s, 120, () => c.sample());
    expect(c.latency()).toBeCloseTo(0.04, 2);
    expect(c.latencySources().outputLatency).toBeCloseTo(0.025, 9);
    expect(c.latencySources().outputTimestamp).toBeCloseTo(0.04, 2);
  });

  it("fonte B ignora timestamps zerados ou absurdos", () => {
    const s = newSim();
    const c = s.clock({ latencySource: "output-timestamp" });
    const orig = s.ctx.getOutputTimestamp;
    (s.ctx as { getOutputTimestamp: unknown }).getOutputTimestamp = () => ({
      contextTime: 0,
      performanceTime: 0,
    });
    frames(s, 30, () => c.sample());
    expect(c.latencySources().outputTimestamp).toBeNull();
    s.tsLatency = 5;
    (s.ctx as { getOutputTimestamp: unknown }).getOutputTimestamp = orig;
    frames(s, 30, () => c.sample());
    expect(c.latencySources().outputTimestamp).toBeNull();
  });

  it("mudança de latência não faz gameTime saltar (rampa de 5ms/s)", () => {
    const s = newSim();
    const c = s.clock({ latencySource: "output-timestamp" });
    frames(s, 120, () => c.sample());
    s.tsLatency = 0.2; // ex.: Bluetooth
    let prev = c.gameTime();
    frames(s, 120, () => {
      c.sample();
      const t = c.gameTime();
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t - prev).toBeLessThan(1 / 60 + 0.005);
      prev = t;
    });
    // 2s depois: +10ms, não +160ms
    expect(c.latency()).toBeGreaterThan(0.045);
    expect(c.latency()).toBeLessThan(0.056);
  });
});
