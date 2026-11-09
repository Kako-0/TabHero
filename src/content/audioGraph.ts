// Grafo de áudio (spec 01): captura o áudio do <video>, entrega uma cópia sem atraso
// ao analisador (worklet) e toca uma cópia atrasada em DELAY_S.
import { CONFIG } from "@/shared/config";
import { log, warn } from "@/shared/log";
import type { AnalyzerCmd } from "@/shared/types";

export const WORKLET_URL = "analyzer.worklet.js";
export const PROCESSOR_NAME = "tabhero-analyzer";
/** Evento emitido quando a ctx sai de `running` sem o jogo ter pedido. */
export const CONTEXT_INTERRUPTED = "context-interrupted";

const MAX_DELAY_S = 2;
/** Velocidade máxima de ajuste da latência suavizada: 5ms por segundo. */
const LATENCY_SLEW_S_PER_S = 0.005;

export type GraphMode = "passthrough" | "game";
export type AudioGraphErrorCode = "SOURCE_TAKEN" | "WORKLET_LOAD_FAILED" | "CONTEXT_FAILED";

export class AudioGraphError extends Error {
  readonly code: AudioGraphErrorCode;

  constructor(code: AudioGraphErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = "AudioGraphError";
    this.code = code;
  }
}

/**
 * Uma entrada por <video>, para sempre: a MediaElementSource não pode ser recriada,
 * e reaproveitar o AudioWorkletNode evita processors órfãos (process() devolve true).
 */
interface VideoEntry {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  analyzer: AudioWorkletNode | null;
}

const entries = new WeakMap<HTMLVideoElement, VideoEntry>();

function isInvalidState(e: unknown): boolean {
  return e instanceof Error && e.name === "InvalidStateError";
}

/**
 * Aproxima um valor-alvo a no máximo `rate` unidades por segundo.
 * Puro (sem relógio próprio) para ser testável.
 */
export class LatencySmoother {
  private current: number | null = null;
  private target = 0;
  private lastMs = 0;

  constructor(private readonly rate: number = LATENCY_SLEW_S_PER_S) {}

  /** Novo valor medido. O primeiro é aplicado imediatamente. */
  setTarget(value: number, nowMs: number): void {
    if (this.current === null) {
      this.current = value;
      this.lastMs = nowMs;
    } else {
      this.advance(nowMs);
    }
    this.target = value;
  }

  value(nowMs: number): number {
    this.advance(nowMs);
    return this.current ?? 0;
  }

  private advance(nowMs: number): void {
    if (this.current === null) return;
    const dt = Math.max(0, nowMs - this.lastMs) / 1000;
    this.lastMs = Math.max(this.lastMs, nowMs);
    const maxStep = this.rate * dt;
    const diff = this.target - this.current;
    this.current += Math.max(-maxStep, Math.min(maxStep, diff));
  }
}

function measureLatency(ctx: AudioContext): number {
  const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  return out + base;
}

async function loadAnalyzer(ctx: AudioContext): Promise<AudioWorkletNode> {
  try {
    // SPIKE 1, opção 1: o arquivo está em web_accessible_resources.
    await ctx.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_URL));
    return new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
  } catch (e) {
    throw new AudioGraphError("WORKLET_LOAD_FAILED", e);
  }
}

function getOrCreateEntry(video: HTMLVideoElement): VideoEntry {
  const existing = entries.get(video);
  if (existing) return existing;

  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
  } catch (e) {
    throw new AudioGraphError("CONTEXT_FAILED", e);
  }

  let source: MediaElementAudioSourceNode;
  try {
    source = ctx.createMediaElementSource(video);
  } catch (e) {
    void ctx.close().catch(() => undefined);
    if (isInvalidState(e)) throw new AudioGraphError("SOURCE_TAKEN", e);
    throw new AudioGraphError("CONTEXT_FAILED", e);
  }

  // A partir daqui o som do vídeo só sai pelo grafo: liga já em passthrough,
  // para o vídeo não ficar mudo se o worklet falhar.
  source.connect(ctx.destination);
  const entry: VideoEntry = { ctx, source, analyzer: null };
  entries.set(video, entry);
  return entry;
}

export class AudioGraph extends EventTarget {
  readonly ctx: AudioContext;
  readonly analyzerPort: MessagePort;

  private _mode: GraphMode = "passthrough";
  private readonly source: MediaElementAudioSourceNode;
  private readonly analyzer: AudioWorkletNode;
  private delay: DelayNode;
  private readonly masterGain: GainNode;
  private readonly latency = new LatencySmoother();
  private rmsTap: { node: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
  private pollId: ReturnType<typeof setInterval> | null = null;
  private suspendRequested = false;
  private disposed = false;

  /** Deve ser chamado dentro do handler do clique em "Jogar" (política de autoplay). */
  static async attach(video: HTMLVideoElement): Promise<AudioGraph> {
    const entry = getOrCreateEntry(video);
    if (!entry.analyzer) entry.analyzer = await loadAnalyzer(entry.ctx);
    if (entry.ctx.state !== "running") {
      try {
        await entry.ctx.resume();
      } catch (e) {
        throw new AudioGraphError("CONTEXT_FAILED", e);
      }
    }
    const graph = new AudioGraph(entry.ctx, entry.source, entry.analyzer);
    log("grafo de áudio pronto", { sampleRate: entry.ctx.sampleRate });
    return graph;
  }

  private constructor(
    ctx: AudioContext,
    source: MediaElementAudioSourceNode,
    analyzer: AudioWorkletNode,
  ) {
    super();
    this.ctx = ctx;
    this.source = source;
    this.analyzer = analyzer;
    this.analyzerPort = analyzer.port;
    this.delay = this.createDelay();
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(ctx.destination);

    this.ctx.addEventListener("statechange", this.onStateChange);
    this.pollLatency();
    this.pollId = setInterval(this.pollLatency, CONFIG.OUTPUT_LATENCY_POLL_MS);
  }

  get mode(): GraphMode {
    return this._mode;
  }

  setMode(mode: GraphMode): void {
    if (this.disposed || mode === this._mode) return;
    if (mode === "game") {
      this.source.disconnect(this.ctx.destination);
      this.source.connect(this.analyzer);
      this.source.connect(this.delay);
      this.delay.connect(this.masterGain);
    } else {
      this.source.disconnect(this.analyzer);
      this.source.disconnect(this.delay);
      this.delay.disconnect();
      this.source.connect(this.ctx.destination);
    }
    this._mode = mode;
    this.send({ type: "set-active", active: mode === "game" });
  }

  /** Recria o DelayNode (descarta o áudio no buffer) e envia `reset` ao analisador. */
  flush(): void {
    if (this.disposed) return;
    const old = this.delay;
    if (this._mode === "game") this.source.disconnect(old);
    old.disconnect();
    this.delay = this.createDelay();
    if (this._mode === "game") {
      this.source.connect(this.delay);
      this.delay.connect(this.masterGain);
    }
    this.send({ type: "reset", at: this.ctx.currentTime });
  }

  async suspend(): Promise<void> {
    this.suspendRequested = true;
    await this.ctx.suspend();
  }

  async resume(): Promise<void> {
    this.suspendRequested = false;
    await this.ctx.resume();
  }

  /** Latência de saída estimada (s), atualizada a cada OUTPUT_LATENCY_POLL_MS. */
  getOutputLatency(): number {
    return this.latency.value(performance.now());
  }

  /**
   * RMS do áudio sem atraso, numa janela de ~43ms (2048 amostras a 48 kHz). Usado pela
   * detecção de DRM (spec 03). O AnalyserNode é criado no 1º uso e fica na saída da source.
   */
  inputRms(): number {
    if (this.disposed) return 0;
    if (!this.rmsTap) {
      const node = this.ctx.createAnalyser();
      node.fftSize = 2048;
      this.source.connect(node);
      this.rmsTap = { node, buf: new Float32Array(node.fftSize) };
    }
    const { node, buf } = this.rmsTap;
    node.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    return Math.sqrt(sum / buf.length);
  }

  /** Volta a passthrough; NÃO destrói a MediaElementSource. */
  dispose(): void {
    if (this.disposed) return;
    this.setMode("passthrough");
    this.disposed = true;
    if (this.pollId !== null) clearInterval(this.pollId);
    this.pollId = null;
    this.ctx.removeEventListener("statechange", this.onStateChange);
    this.delay.disconnect();
    this.masterGain.disconnect();
    if (this.rmsTap) this.source.disconnect(this.rmsTap.node);
    this.rmsTap = null;
  }

  private createDelay(): DelayNode {
    const d = this.ctx.createDelay(MAX_DELAY_S);
    d.delayTime.value = CONFIG.DELAY_S;
    return d;
  }

  private send(cmd: AnalyzerCmd): void {
    this.analyzerPort.postMessage(cmd);
  }

  private readonly pollLatency = (): void => {
    this.latency.setTarget(measureLatency(this.ctx), performance.now());
  };

  private readonly onStateChange = (): void => {
    const state = this.ctx.state as AudioContextState | "interrupted";
    if (state === "running") return;
    if (state === "suspended" && this.suspendRequested) return;
    warn("AudioContext saiu de running sem pedido:", state);
    this.dispatchEvent(new Event(CONTEXT_INTERRUPTED));
  };
}
