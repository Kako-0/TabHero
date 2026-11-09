// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04, etapa 1).
import FFT from "fft.js";

/** Buffer circular de amostras endereçado por índice absoluto. */
export class SampleRing {
  private readonly buf: Float32Array;
  private readonly mask: number;
  /** Total de amostras já escritas (índice absoluto da próxima). */
  count = 0;

  /** `size` precisa ser potência de 2. */
  constructor(size: number) {
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) this.buf[(this.count + i) & this.mask] = samples[i]!;
    this.count += samples.length;
  }

  /** Copia `out.length` amostras a partir do índice absoluto `start`. */
  read(start: number, out: Float32Array): void {
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(start + i) & this.mask]!;
  }
}

/** Espectro de magnitude com janela de Hann. */
export class Stft {
  readonly bins: number;
  private readonly fft: FFT;
  private readonly window: Float64Array;
  private readonly input: Float64Array;
  private readonly spec: Float64Array;
  private readonly norm: number;

  constructor(readonly size: number) {
    this.bins = size / 2 + 1;
    this.fft = new FFT(size);
    this.window = new Float64Array(size);
    let sum = 0;
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
      sum += this.window[i]!;
    }
    // Normalizado: uma senoide de amplitude A dá |X| ≈ A no bin dela.
    this.norm = 2 / sum;
    this.input = new Float64Array(size);
    this.spec = new Float64Array(2 * size);
  }

  /** Preenche `mag` (tamanho `bins`) com |X[k]| do quadro. */
  magnitude(frame: Float32Array, mag: Float64Array): void {
    for (let i = 0; i < this.size; i++) this.input[i] = frame[i]! * this.window[i]!;
    this.fft.realTransform(this.spec, this.input);
    for (let k = 0; k < this.bins; k++) {
      const re = this.spec[2 * k]!;
      const im = this.spec[2 * k + 1]!;
      mag[k] = Math.sqrt(re * re + im * im) * this.norm;
    }
  }
}
