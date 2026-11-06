// AudioWorklet no-op (setup). O analisador real entra no M1 (spec 04).
import { StreamAnalyzer } from "@/analysis/streamAnalyzer";
import type { AnalyzerCmd } from "@/shared/types";

class TabHeroAnalyzerProcessor extends AudioWorkletProcessor {
  private readonly analyzer = new StreamAnalyzer(sampleRate);

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = (ev) => {
      const msgs = this.analyzer.command(ev.data as AnalyzerCmd);
      for (const m of msgs) this.port.postMessage(m);
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch) {
      const msgs = this.analyzer.push(ch, currentFrame / sampleRate);
      for (const m of msgs) this.port.postMessage(m);
    }
    return true;
  }
}

registerProcessor("tabhero-analyzer", TabHeroAnalyzerProcessor);
