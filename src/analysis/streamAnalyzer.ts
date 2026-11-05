// Puro: sem DOM nem APIs de áudio. Roda no worklet e em Node (spec 04).
import type { AnalyzerCmd, AnalyzerMsg } from "@/shared/types";

export class StreamAnalyzer {
  /** Recebe um bloco mono em ANALYSIS_SR começando em `procTime`. Stub: não detecta nada. */
  push(_samples: Float32Array, _procTime: number): AnalyzerMsg[] {
    return [];
  }

  command(cmd: AnalyzerCmd): AnalyzerMsg[] {
    if (cmd.type === "reset") return [{ type: "reset-ack", at: cmd.at }];
    return [];
  }
}
