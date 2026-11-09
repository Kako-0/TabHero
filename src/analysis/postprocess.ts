// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04, etapa 5).
import type { Lane } from "@/shared/types";

export interface PostprocessConfig {
  blankAfterResetS: number;
  laneMinGapS: number;
  maxNotesPerS: number;
}

interface Emitted {
  t: number;
  lane: Lane;
  strength: number;
}

/** Filtro causal: blank após início/reset, distância mínima por pista e densidade máxima. */
export class NoteFilter {
  private recent: Emitted[] = [];
  private blankUntil = -Infinity;

  constructor(private readonly cfg: PostprocessConfig) {}

  /** Reinicia a partir de `start` (início da análise ou `reset`). */
  restart(start: number): void {
    this.recent = [];
    this.blankUntil = start + this.cfg.blankAfterResetS;
  }

  /** Devolve a pista final da nota, ou `null` se ela é descartada. */
  accept(t: number, lane: Lane, alt: Lane, strength: number): Lane | null {
    if (t < this.blankUntil) return null;
    while (this.recent.length > 0 && this.recent[0]!.t < t - 1) this.recent.shift();

    const busy = (l: Lane) =>
      this.recent.find((n) => n.lane === l && t - n.t < this.cfg.laneMinGapS) ?? null;
    const conflict = busy(lane);
    if (conflict) {
      if (strength > conflict.strength && !busy(alt)) lane = alt;
      else return null;
    }
    // Janela de 1s fechada: garante ≤ max em qualquer janela de 1s.
    if (this.recent.length >= this.cfg.maxNotesPerS) return null;

    this.recent.push({ t, lane, strength });
    return lane;
  }
}
