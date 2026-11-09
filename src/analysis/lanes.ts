// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04, etapa 4).
import type { Lane } from "@/shared/types";

/** Limites fixos (Hz) usados enquanto o histórico tem menos de `MIN_HISTORY` onsets. */
const FIXED_LIMITS_HZ = [300, 1000, 2500];
const FIXED_LIMITS = FIXED_LIMITS_HZ.map(Math.log);
const MIN_HISTORY = 12;
/** Anti-jackhammer: mudança relativa de centroide abaixo disso mantém a pista. */
const SAME_CENTROID = 0.05;

export interface LaneChoice {
  lane: Lane;
  /** Pista adjacente mais próxima em centroide (para o conflito de LANE_MIN_GAP_S). */
  alt: Lane;
}

/** Centroide relativo → pista, por quartil do histórico recente. */
export class LaneAssigner {
  private readonly hist: { t: number; logc: number }[] = [];
  private readonly sorted: number[] = [];
  private readonly limits = [0, 0, 0];
  /** Pistas das últimas notas emitidas e o centroide da última. */
  private recentLanes: Lane[] = [];
  private lastCentroid = 0;

  constructor(private readonly windowS: number) {}

  reset(): void {
    this.hist.length = 0;
    this.recentLanes = [];
    this.lastCentroid = 0;
  }

  /** Escolhe a pista do onset em `t` com centroide `c` (Hz) e o põe no histórico. */
  assign(t: number, c: number): LaneChoice {
    while (this.hist.length > 0 && this.hist[0]!.t < t - this.windowS) this.hist.shift();
    const logc = Math.log(Math.max(c, 1));

    let limits = FIXED_LIMITS;
    if (this.hist.length >= MIN_HISTORY) {
      this.sorted.length = 0;
      for (const h of this.hist) this.sorted.push(h.logc);
      this.sorted.sort((a, b) => a - b);
      for (let q = 0; q < 3; q++) this.limits[q] = quantile(this.sorted, (q + 1) / 4);
      limits = this.limits;
    }
    this.hist.push({ t, logc });

    let lane = 0;
    while (lane < 3 && logc > limits[lane]!) lane++;

    const r = this.recentLanes;
    if (
      r.length >= 3 &&
      r[0] === r[1] &&
      r[1] === r[2] &&
      Math.abs(c / this.lastCentroid - 1) < SAME_CENTROID
    ) {
      lane = r[2]!;
    }

    let alt: number;
    if (lane === 0) alt = 1;
    else if (lane === 3) alt = 2;
    else alt = logc - limits[lane - 1]! < limits[lane]! - logc ? lane - 1 : lane + 1;
    return { lane: lane as Lane, alt: alt as Lane };
  }

  /** Registra a pista final de uma nota emitida (anti-jackhammer). */
  noteEmitted(lane: Lane, c: number): void {
    this.recentLanes.push(lane);
    if (this.recentLanes.length > 3) this.recentLanes.shift();
    this.lastCentroid = c;
  }
}

function quantile(sorted: number[], q: number): number {
  const p = (sorted.length - 1) * q;
  const i = Math.floor(p);
  const f = p - i;
  return i + 1 < sorted.length ? sorted[i]! + f * (sorted[i + 1]! - sorted[i]!) : sorted[i]!;
}
