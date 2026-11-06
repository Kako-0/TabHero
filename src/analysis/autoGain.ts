// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node.
// Ganho automático por RMS móvel (spec 01, SPIKE 2): `video.volume` é aplicado antes
// da MediaElementSource, então o analisador recebe o sinal já atenuado. Normalizar
// deixa a análise independente do volume escolhido pelo usuário.
import { CONFIG } from "@/shared/config";

export interface AutoGainConfig {
  /** RMS alvo do sinal normalizado. */
  targetRms: number;
  /** Constante de tempo da média móvel do quadrado (s). Longa, para preservar a dinâmica. */
  tauS: number;
  /** Ganho máximo (limita o reforço de ruído). */
  maxGain: number;
  /** Blocos com RMS abaixo disso são silêncio: não atualizam a média, e o ganho fica congelado. */
  silenceRms: number;
}

export const DEFAULT_AUTO_GAIN: AutoGainConfig = {
  targetRms: CONFIG.AGC_TARGET_RMS,
  tauS: CONFIG.AGC_TAU_S,
  maxGain: CONFIG.AGC_MAX_GAIN,
  silenceRms: CONFIG.AGC_SILENCE_RMS,
};

export class AutoGain {
  private meanSquare: number | null = null;
  private _gain = 1;
  private out = new Float32Array(0);

  constructor(
    private readonly sampleRate: number,
    private readonly cfg: AutoGainConfig = DEFAULT_AUTO_GAIN,
  ) {}

  /** Ganho aplicado no último bloco. */
  get gain(): number {
    return this._gain;
  }

  /**
   * Devolve o bloco normalizado. O array devolvido é um buffer interno reutilizado
   * (sem alocação no caminho quente): vale até a próxima chamada.
   */
  process(block: Float32Array): Float32Array {
    const n = block.length;
    if (this.out.length < n) this.out = new Float32Array(n);
    const out = this.out.subarray(0, n);
    if (n === 0) return out;

    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = block[i]!;
      sum += x * x;
    }
    const blockMs = sum / n;

    if (blockMs >= this.cfg.silenceRms * this.cfg.silenceRms) {
      if (this.meanSquare === null) {
        this.meanSquare = blockMs; // primeiro bloco com som: começa já calibrado
      } else {
        const alpha = 1 - Math.exp(-n / (this.cfg.tauS * this.sampleRate));
        this.meanSquare += alpha * (blockMs - this.meanSquare);
      }
      this._gain = Math.min(this.cfg.maxGain, this.cfg.targetRms / Math.sqrt(this.meanSquare));
    }

    const g = this._gain;
    for (let i = 0; i < n; i++) out[i] = block[i]! * g;
    return out;
  }
}
