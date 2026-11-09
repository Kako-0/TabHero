// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04, etapa 1).

/**
 * Reamostragem linear em streaming, contínua entre blocos.
 * A saída n corresponde à posição de entrada `n · inRate / outRate`, então o tempo da
 * saída n é `t0 + n / outRate` (t0 = tempo da primeira amostra de entrada).
 */
export class LinearResampler {
  private readonly step: number;
  /** Amostras de entrada já consumidas (índice global da próxima entrada). */
  private inCount = 0;
  /** Amostras de saída já produzidas. */
  private outCount = 0;
  private prev = 0;
  private out = new Float32Array(0);

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    this.step = inRate / outRate;
  }

  /** Devolve as amostras novas num buffer interno reutilizado (vale até a próxima chamada). */
  process(input: Float32Array): Float32Array {
    const m = input.length;
    const maxOut = Math.ceil(m / this.step) + 2;
    if (this.out.length < maxOut) this.out = new Float32Array(maxOut);
    const g0 = this.inCount;
    const last = g0 + m - 1;
    let k = 0;
    for (;;) {
      const pos = this.outCount * this.step;
      if (pos > last) break;
      const i = Math.floor(pos);
      const frac = pos - i;
      const x0 = i < g0 ? this.prev : input[i - g0]!;
      let y = x0;
      if (frac > 0) {
        if (i + 1 > last) break; // falta a próxima amostra: espera o próximo bloco
        y = x0 + frac * (input[i + 1 - g0]! - x0);
      }
      this.out[k++] = y;
      this.outCount++;
    }
    if (m > 0) this.prev = input[m - 1]!;
    this.inCount += m;
    return this.out.subarray(0, k);
  }
}
