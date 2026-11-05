// Stub do setup (spec 01): cria o AudioContext e carrega o worklet no-op.
import { log } from "@/shared/log";

const ctxByVideo = new WeakMap<HTMLVideoElement, AudioContext>();

export const WORKLET_URL = "analyzer.worklet.js";
export const PROCESSOR_NAME = "tabhero-analyzer";

/** Deve ser chamado dentro do handler do clique (política de autoplay). */
export async function loadWorkletProbe(video: HTMLVideoElement): Promise<AudioContext> {
  let ctx = ctxByVideo.get(video);
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    ctxByVideo.set(video, ctx);
    await ctx.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_URL));
    // Instanciar o nó confirma que o processor foi registrado.
    new AudioWorkletNode(ctx, PROCESSOR_NAME, { numberOfOutputs: 0 });
    log("worklet ok");
  }
  if (ctx.state !== "running") await ctx.resume();
  return ctx;
}
