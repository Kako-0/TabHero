// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04, etapa 3).

export interface OnsetConfig {
  /** Quadros de passado na janela do threshold (~1s). */
  pastFrames: number;
  /** Quadros de lookahead: a decisão do quadro i sai quando chega o flux do quadro i + lookahead. */
  lookahead: number;
  /** Raio do máximo local (±quadros). */
  peakRadius: number;
  k: number;
  deltaRatio: number;
  /** Distância mínima entre onsets, em quadros. */
  minGapFrames: number;
}

export interface OnsetDecision {
  /** Quadro decidido (é um onset se `onset`). */
  frame: number;
  /** Posição do pico relativa ao quadro (fração de hop), por interpolação parabólica. */
  offset: number;
  onset: boolean;
  strength: number;
}

const RING = 512;
const MASK = RING - 1;

/**
 * Função de detecção (flux suavizado em 3 quadros, centrado) + threshold adaptativo
 * `mediana + K·MAD + δ` numa janela de passado + lookahead + peak picking.
 */
export class OnsetDetector {
  private readonly flux = new Float64Array(RING);
  private readonly odf = new Float64Array(RING);
  private readonly scratch: Float64Array;
  /** Quantidade de quadros de flux recebidos. */
  private n = 0;
  private lastOnset = -Infinity;

  constructor(private readonly cfg: OnsetConfig) {
    if (cfg.pastFrames + cfg.lookahead + cfg.peakRadius + 4 > RING)
      throw new Error("janela grande demais");
    this.scratch = new Float64Array(cfg.pastFrames + cfg.lookahead + 1);
  }

  reset(): void {
    this.n = 0;
    this.lastOnset = -Infinity;
  }

  /** Recebe o flux do próximo quadro; devolve a decisão do quadro `n − lookahead`, se houver. */
  push(flux: number): OnsetDecision | null {
    const k = this.n++;
    this.flux[k & MASK] = flux;
    // odf[k−1] = média de flux[k−2..k] (quadros antes do início contam como ausentes)
    if (k >= 1) {
      const a = k >= 2 ? this.flux[(k - 2) & MASK]! : 0;
      const c = k >= 2 ? 3 : 2;
      this.odf[(k - 1) & MASK] = (a + this.flux[(k - 1) & MASK]! + flux) / c;
    }
    const i = k - this.cfg.lookahead;
    if (i < 0) return null;
    return this.decide(i, k - 1);
  }

  /** Decide o quadro `i`; `last` é o último quadro com odf disponível. */
  private decide(i: number, last: number): OnsetDecision {
    const { pastFrames, peakRadius, k, deltaRatio, minGapFrames } = this.cfg;
    const v = this.odf[i & MASK]!;
    const no: OnsetDecision = { frame: i, offset: 0, onset: false, strength: 0 };
    if (v <= 0) return no;

    // Máximo local: estritamente maior que os anteriores, ≥ que os seguintes (platôs → primeiro).
    for (let j = Math.max(0, i - peakRadius); j < i; j++) if (this.odf[j & MASK]! >= v) return no;
    for (let j = i + 1; j <= Math.min(last, i + peakRadius); j++)
      if (this.odf[j & MASK]! > v) return no;
    if (i - this.lastOnset < minGapFrames) return no;

    const from = Math.max(0, i - pastFrames);
    const len = last - from + 1;
    const w = this.scratch.subarray(0, len);
    let max = 0;
    for (let j = 0; j < len; j++) {
      const x = this.odf[(from + j) & MASK]!;
      w[j] = x;
      if (x > max) max = x;
    }
    w.sort();
    const med = median(w);
    for (let j = 0; j < len; j++) w[j] = Math.abs(w[j]! - med);
    w.sort();
    const mad = median(w);
    const thr = med + k * mad + deltaRatio * max;
    if (v <= thr) return no;

    this.lastOnset = i;
    // Interpolação parabólica do pico: posição sub-quadro em [−0,5; 0,5].
    const a = i > 0 ? this.odf[(i - 1) & MASK]! : 0;
    const c = this.odf[(i + 1) & MASK]!;
    const den = a - 2 * v + c;
    const offset = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return { frame: i, offset, onset: true, strength: (v - thr) / Math.max(thr, 1e-12) };
  }
}

/** Mediana de um array já ordenado. */
function median(sorted: Float64Array): number {
  const n = sorted.length;
  const h = n >> 1;
  return n % 2 ? sorted[h]! : (sorted[h - 1]! + sorted[h]!) / 2;
}
