// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04, etapa 2).
// Flux/centroide/rms implementados aqui sobre o `fft.js` (plano B da spec 04: o flux
// pedido, log(1 + 10·|X|) entre 30 Hz e 8 kHz, não é o do Meyda). Pitch via `pitchy` (MPM).
import { PitchDetector } from "pitchy";

const FLUX_LOG_GAIN = 10;
const FLUX_MIN_HZ = 30;
const FLUX_MAX_HZ = 8000;

export class SpectralFeatures {
  private readonly lo: number;
  private readonly hi: number;
  private readonly binHz: number;
  private logMag: Float64Array;
  private prevLogMag: Float64Array;
  private hasPrev = false;

  constructor(sampleRate: number, fftSize: number) {
    const bins = fftSize / 2 + 1;
    this.binHz = sampleRate / fftSize;
    this.lo = Math.max(1, Math.ceil(FLUX_MIN_HZ / this.binHz));
    this.hi = Math.min(bins - 1, Math.floor(FLUX_MAX_HZ / this.binHz));
    this.logMag = new Float64Array(bins);
    this.prevLogMag = new Float64Array(bins);
  }

  reset(): void {
    this.hasPrev = false;
  }

  /** Spectral flux positivo sobre o log-magnitude. O primeiro quadro compara com silêncio. */
  flux(mag: Float64Array): number {
    const cur = this.logMag;
    const prev = this.prevLogMag;
    let flux = 0;
    for (let k = this.lo; k <= this.hi; k++) {
      const l = Math.log(1 + FLUX_LOG_GAIN * mag[k]!);
      cur[k] = l;
      const d = l - (this.hasPrev ? prev[k]! : 0);
      if (d > 0) flux += d;
    }
    this.logMag = prev;
    this.prevLogMag = cur;
    this.hasPrev = true;
    return flux;
  }

  /** Centroide espectral em Hz (0 se o quadro é silêncio). */
  centroid(mag: Float64Array): number {
    let num = 0;
    let den = 0;
    for (let k = 1; k < mag.length; k++) {
      num += k * mag[k]!;
      den += mag[k]!;
    }
    return den > 0 ? (num / den) * this.binHz : 0;
  }
}

export function rms(frame: Float32Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
  return Math.sqrt(s / frame.length);
}

/** Pitch (Hz) e clarity (0–1) por MPM. */
export class PitchTracker {
  private readonly detector: PitchDetector<Float32Array>;

  constructor(
    private readonly sampleRate: number,
    frameSize: number,
  ) {
    this.detector = PitchDetector.forFloat32Array(frameSize);
  }

  detect(frame: Float32Array): { pitch: number; clarity: number } {
    const [pitch, clarity] = this.detector.findPitch(frame, this.sampleRate);
    return { pitch, clarity };
  }
}

export const semitones = (a: number, b: number): number => 12 * Math.log2(a / b);
