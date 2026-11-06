// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04).
import { CONFIG } from "@/shared/config";
import type { AnalyzerCmd, AnalyzerMsg } from "@/shared/types";
import { AutoGain } from "./autoGain";

export class StreamAnalyzer {
  /** Normaliza o volume antes de tudo (spec 04, etapa 0). Não é zerado no `reset`. */
  private readonly agc: AutoGain;

  constructor(inputSampleRate: number = CONFIG.ANALYSIS_SR) {
    this.agc = new AutoGain(inputSampleRate);
  }

  /** Recebe um bloco mono no SR de entrada começando em `procTime`. Stub: não detecta nada. */
  push(samples: Float32Array, _procTime: number): AnalyzerMsg[] {
    this.agc.process(samples);
    return [];
  }

  command(cmd: AnalyzerCmd): AnalyzerMsg[] {
    if (cmd.type === "reset") return [{ type: "reset-ack", at: cmd.at }];
    return [];
  }
}
