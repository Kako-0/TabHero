// AudioWorklet do analisador (spec 04): downmix → streamAnalyzer → mensagens pela porta.
import { createStreamAnalyzer } from "@/analysis/streamAnalyzer";
import type { AnalyzerCmd } from "@/shared/types";

class TabHeroAnalyzerProcessor extends AudioWorkletProcessor {
  private readonly analyzer = createStreamAnalyzer(sampleRate);
  private active = false;
  private mono = new Float32Array(128);

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = (ev) => {
      const cmd = ev.data as AnalyzerCmd;
      if (cmd.type === "set-active") this.active = cmd.active;
      else if (cmd.type === "reset")
        for (const m of this.analyzer.reset(cmd.at)) this.port.postMessage(m);
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return true;
    const chans = inputs[0];
    if (!chans || chans.length === 0) return true;
    const n = chans[0]!.length;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const mono = this.mono;
    if (chans.length === 1) {
      mono.set(chans[0]!);
    } else {
      mono.fill(0);
      for (const ch of chans) for (let i = 0; i < n; i++) mono[i]! += ch[i]!;
      const g = 1 / chans.length;
      for (let i = 0; i < n; i++) mono[i]! *= g;
    }
    const msgs = this.analyzer.push(mono, currentFrame / sampleRate);
    for (const m of msgs) this.port.postMessage(m);
    return true;
  }
}

registerProcessor("tabhero-analyzer", TabHeroAnalyzerProcessor);
