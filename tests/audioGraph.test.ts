import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioGraph,
  AudioGraphError,
  CONTEXT_INTERRUPTED,
  LatencySmoother,
} from "@/content/audioGraph";
import { CONFIG } from "@/shared/config";
import {
  FakeAudioContext,
  type FakeAnalyserNode,
  type FakeDelayNode,
  type FakeNode,
  type FakeWorkletNode,
  installWebAudioFake,
} from "./webAudioFake";

const newVideo = () => ({}) as HTMLVideoElement;

function parts(ctx: FakeAudioContext) {
  const [source] = ctx.find("source") as [FakeNode];
  const [worklet] = ctx.find("worklet") as [FakeWorkletNode];
  return { source, worklet, dest: ctx.destination };
}

function liveDelays(ctx: FakeAudioContext): FakeDelayNode[] {
  const { source } = parts(ctx);
  return [...source.outputs].filter((n) => n.kind === "delay") as FakeDelayNode[];
}

async function attach() {
  const g = await AudioGraph.attach(newVideo());
  const ctx = g.ctx as unknown as FakeAudioContext;
  return { g, ctx, ...parts(ctx) };
}

beforeEach(() => {
  installWebAudioFake();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AudioGraph.attach", () => {
  it("cria ctx interativa, carrega o worklet, retoma a ctx e termina em passthrough", async () => {
    const { g, ctx, source, dest, worklet } = await attach();
    expect(ctx.options).toEqual({ latencyHint: "interactive" });
    expect(ctx.loadedModules).toEqual(["chrome-extension://test/analyzer.worklet.js"]);
    expect(worklet.name).toBe("tabhero-analyzer");
    expect(ctx.state).toBe("running");
    expect(g.mode).toBe("passthrough");
    expect([...source.outputs]).toEqual([dest]);
    g.dispose();
  });

  it("dupla attach no mesmo vídeo reutiliza ctx, source e worklet", async () => {
    const video = newVideo();
    const a = await AudioGraph.attach(video);
    a.dispose();
    const b = await AudioGraph.attach(video);
    expect(b.ctx).toBe(a.ctx);
    expect(b.analyzerPort).toBe(a.analyzerPort);
    const ctx = b.ctx as unknown as FakeAudioContext;
    expect(ctx.find("source")).toHaveLength(1);
    expect(ctx.find("worklet")).toHaveLength(1);
    expect(ctx.loadedModules).toHaveLength(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
    b.dispose();
  });

  it("source já criada por outro → SOURCE_TAKEN e fecha a ctx nova", async () => {
    const video = newVideo();
    new FakeAudioContext().createMediaElementSource(video); // "outra extensão"
    const err = await AudioGraph.attach(video).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudioGraphError);
    expect((err as AudioGraphError).code).toBe("SOURCE_TAKEN");
    expect(FakeAudioContext.instances[1]?.closed).toBe(true);
  });

  it("falha no worklet → WORKLET_LOAD_FAILED, mas o vídeo continua com som; retry funciona", async () => {
    const video = newVideo();
    FakeAudioContext.failAddModule = true;
    const err = await AudioGraph.attach(video).catch((e: unknown) => e);
    expect((err as AudioGraphError).code).toBe("WORKLET_LOAD_FAILED");
    const ctx = FakeAudioContext.instances[0]!;
    expect([...parts(ctx).source.outputs]).toEqual([ctx.destination]);

    FakeAudioContext.failAddModule = false;
    const g = await AudioGraph.attach(video);
    expect(g.ctx).toBe(ctx as unknown as AudioContext);
    g.dispose();
  });

  it("AudioContext indisponível → CONTEXT_FAILED", async () => {
    Object.assign(globalThis, {
      AudioContext: class {
        constructor() {
          throw new Error("no audio");
        }
      },
    });
    const err = await AudioGraph.attach(newVideo()).catch((e: unknown) => e);
    expect((err as AudioGraphError).code).toBe("CONTEXT_FAILED");
  });
});

describe("modos", () => {
  it("game: source → analyzer + delay(DELAY_S) → gain → destination", async () => {
    const { g, ctx, source, worklet, dest } = await attach();
    g.setMode("game");
    expect(g.mode).toBe("game");
    expect(source.outputs.has(dest)).toBe(false);
    expect(source.outputs.has(worklet)).toBe(true);
    const [delay] = liveDelays(ctx);
    expect(delay?.maxDelayTime).toBe(2);
    expect(delay?.delayTime.value).toBe(CONFIG.DELAY_S);
    const [gain] = [...delay!.outputs];
    expect(gain?.kind).toBe("gain");
    expect([...gain!.outputs]).toEqual([dest]);
    expect(worklet.port.sent).toEqual([{ type: "set-active", active: true }]);
    g.dispose();
  });

  it("passthrough desfaz a topologia de jogo e envia set-active false", async () => {
    const { g, source, worklet, dest } = await attach();
    g.setMode("game");
    g.setMode("passthrough");
    expect([...source.outputs]).toEqual([dest]);
    expect(worklet.port.sent.at(-1)).toEqual({ type: "set-active", active: false });
    g.dispose();
  });

  it("setMode para o modo atual é no-op", async () => {
    const { g, worklet } = await attach();
    g.setMode("passthrough");
    expect(worklet.port.sent).toEqual([]);
    g.dispose();
  });

  it("alternar game ↔ passthrough 20 vezes não cria nós nem arestas a mais", async () => {
    const { g, ctx } = await attach();
    g.setMode("game");
    const nodes = ctx.nodes.length;
    const edges = ctx.edges().length;
    for (let i = 0; i < 20; i++) {
      g.setMode("passthrough");
      g.setMode("game");
    }
    expect(ctx.nodes.length).toBe(nodes);
    expect(ctx.edges().length).toBe(edges);
    g.dispose();
  });
});

describe("flush", () => {
  it("troca o DelayNode, desliga o antigo e envia reset com ctx.currentTime", async () => {
    const { g, ctx, worklet } = await attach();
    g.setMode("game");
    const [old] = liveDelays(ctx);
    ctx.currentTime = 12.5;
    g.flush();
    const [fresh] = liveDelays(ctx);
    expect(liveDelays(ctx)).toHaveLength(1);
    expect(fresh).not.toBe(old);
    expect(old!.outputs.size).toBe(0);
    expect(fresh!.delayTime.value).toBe(CONFIG.DELAY_S);
    expect([...fresh!.outputs][0]?.kind).toBe("gain");
    expect(worklet.port.sent.at(-1)).toEqual({ type: "reset", at: 12.5 });
    g.dispose();
  });

  it("em passthrough não liga o delay novo", async () => {
    const { g, ctx, source, dest, worklet } = await attach();
    g.flush();
    expect([...source.outputs]).toEqual([dest]);
    expect(liveDelays(ctx)).toHaveLength(0);
    expect(worklet.port.sent).toEqual([{ type: "reset", at: 0 }]);
    g.dispose();
  });
});

describe("setAnalysisActive", () => {
  it("envia set-active sem mudar o roteamento", async () => {
    const { g, ctx, worklet } = await attach();
    g.setMode("game");
    const before = liveDelays(ctx);
    g.setAnalysisActive(false);
    expect(worklet.port.sent.at(-1)).toEqual({ type: "set-active", active: false });
    expect(liveDelays(ctx)).toEqual(before);
    g.setAnalysisActive(true);
    expect(worklet.port.sent.at(-1)).toEqual({ type: "set-active", active: true });
    g.dispose();
  });
});

describe("suspend/resume e statechange", () => {
  it("suspend pedido pelo jogo não emite context-interrupted", async () => {
    const { g, ctx } = await attach();
    const spy = vi.fn();
    g.addEventListener(CONTEXT_INTERRUPTED, spy);
    await g.suspend();
    expect(ctx.state).toBe("suspended");
    await g.resume();
    expect(ctx.state).toBe("running");
    expect(spy).not.toHaveBeenCalled();
    g.dispose();
  });

  it("suspensão ou interrupção pelo sistema emite context-interrupted", async () => {
    const { g, ctx } = await attach();
    const spy = vi.fn();
    g.addEventListener(CONTEXT_INTERRUPTED, spy);
    ctx.setState("interrupted");
    ctx.setState("running");
    ctx.setState("suspended");
    expect(spy).toHaveBeenCalledTimes(2);
    g.dispose();
  });

  it("após dispose não emite mais", async () => {
    const { g, ctx } = await attach();
    const spy = vi.fn();
    g.addEventListener(CONTEXT_INTERRUPTED, spy);
    g.dispose();
    ctx.setState("suspended");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("volta a passthrough, mantém a source e para o polling", async () => {
    const { g, ctx, source, dest } = await attach();
    g.setMode("game");
    g.dispose();
    expect(g.mode).toBe("passthrough");
    expect([...source.outputs]).toEqual([dest]);
    expect(ctx.find("source")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("latência de saída", () => {
  it("soma outputLatency + baseLatency e ajusta no máximo 5ms/s", async () => {
    const { g, ctx } = await attach();
    expect(g.getOutputLatency()).toBeCloseTo(0.025, 6);

    ctx.outputLatency = 0.12; // ex.: troca para Bluetooth
    vi.advanceTimersByTime(CONFIG.OUTPUT_LATENCY_POLL_MS);
    // poll aplica o novo alvo; mais 2s → +10ms
    vi.advanceTimersByTime(2000);
    expect(g.getOutputLatency()).toBeCloseTo(0.035, 4);
    g.dispose();
  });

  it("LatencySmoother: primeiro valor imediato, depois rampa limitada nos dois sentidos", () => {
    const s = new LatencySmoother(0.005);
    s.setTarget(0.05, 0);
    expect(s.value(0)).toBe(0.05);
    s.setTarget(0.0, 1000);
    expect(s.value(3000)).toBeCloseTo(0.04, 9);
    expect(s.value(100_000)).toBe(0);
    s.setTarget(0.001, 100_000);
    expect(s.value(200_000)).toBeCloseTo(0.001, 9);
  });
});

describe("inputRms (DRM, spec 03)", () => {
  it("cria o AnalyserNode no 1º uso, na saída da source, e desliga no dispose", async () => {
    const { g, ctx, source } = await attach();
    expect(ctx.find("analyser")).toHaveLength(0);
    expect(g.inputRms()).toBe(0);
    const [an] = ctx.find("analyser") as [FakeAnalyserNode];
    expect(source.outputs.has(an)).toBe(true);
    an.signal = 0.5;
    expect(g.inputRms()).toBeCloseTo(0.5, 6);
    expect(ctx.find("analyser")).toHaveLength(1);
    g.setMode("game");
    g.setMode("passthrough");
    expect(source.outputs.has(an)).toBe(true);
    g.dispose();
    expect(source.outputs.has(an)).toBe(false);
    expect(g.inputRms()).toBe(0);
  });
});
