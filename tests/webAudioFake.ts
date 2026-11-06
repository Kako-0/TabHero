// Fake mínimo de Web Audio que rastreia as conexões do grafo (o mock padronizado não rastreia).
let nextId = 0;

export class FakeNode {
  readonly id = ++nextId;
  readonly outputs = new Set<FakeNode>();
  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect(dest: FakeNode): FakeNode {
    this.outputs.add(dest);
    return dest;
  }
  disconnect(dest?: FakeNode): void {
    if (!dest) {
      this.outputs.clear();
      return;
    }
    if (!this.outputs.delete(dest)) {
      const e = new Error("not connected");
      e.name = "InvalidAccessError";
      throw e;
    }
  }
}

class FakeParam {
  value = 0;
}

export class FakeDelayNode extends FakeNode {
  readonly delayTime = new FakeParam();
  constructor(
    ctx: FakeAudioContext,
    readonly maxDelayTime: number,
  ) {
    super(ctx, "delay");
  }
}

export class FakeGainNode extends FakeNode {
  readonly gain = new FakeParam();
  constructor(ctx: FakeAudioContext) {
    super(ctx, "gain");
    this.gain.value = 1;
  }
}

export class FakePort {
  readonly sent: unknown[] = [];
  postMessage(msg: unknown): void {
    this.sent.push(msg);
  }
}

export class FakeWorkletNode extends FakeNode {
  readonly port = new FakePort();
  constructor(
    ctx: FakeAudioContext,
    readonly name: string,
    readonly options?: unknown,
  ) {
    super(ctx, "worklet");
    if (!ctx.loadedModules.length) throw new Error("processor not registered");
  }
}

/** Elementos que já têm uma MediaElementSource em qualquer contexto. */
const takenElements = new WeakSet<object>();

export class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  static failAddModule = false;

  readonly nodes: FakeNode[] = [];
  readonly loadedModules: string[] = [];
  readonly destination = new FakeNode(this, "destination");
  state: AudioContextState | "interrupted" = "suspended";
  currentTime = 0;
  outputLatency = 0.02;
  baseLatency = 0.005;
  sampleRate = 48000;
  closed = false;

  readonly audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      if (FakeAudioContext.failAddModule) throw new Error("load failed");
      this.loadedModules.push(url);
    },
  };

  constructor(readonly options?: unknown) {
    super();
    FakeAudioContext.instances.push(this);
  }

  createMediaElementSource(el: object): FakeNode {
    if (takenElements.has(el)) {
      const e = new Error("already connected");
      e.name = "InvalidStateError";
      throw e;
    }
    takenElements.add(el);
    return new FakeNode(this, "source");
  }
  createDelay(max: number): FakeDelayNode {
    return new FakeDelayNode(this, max);
  }
  createGain(): FakeGainNode {
    return new FakeGainNode(this);
  }
  async resume(): Promise<void> {
    this.setState("running");
  }
  async suspend(): Promise<void> {
    this.setState("suspended");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.setState("closed");
  }
  setState(s: AudioContextState | "interrupted"): void {
    if (s === this.state) return;
    this.state = s;
    this.dispatchEvent(new Event("statechange"));
  }

  /** Arestas ativas (de → para) por `kind`, para inspecionar a topologia. */
  edges(): string[] {
    const out: string[] = [];
    for (const n of this.nodes)
      for (const d of n.outputs) out.push(`${n.kind}#${n.id}->${d.kind}#${d.id}`);
    return out;
  }
  find(kind: string): FakeNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }
}

export function installWebAudioFake(): void {
  FakeAudioContext.instances = [];
  FakeAudioContext.failAddModule = false;
  Object.assign(globalThis, {
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    chrome: { runtime: { getURL: (p: string) => `chrome-extension://test/${p}` } },
  });
}
