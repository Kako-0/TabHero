import { beforeEach, describe, expect, it } from "vitest";
import { createVideoDelay, type VideoDelayOptions } from "@/content/videoDelay";
import { CONFIG } from "@/shared/config";

class FakeBitmap {
  closed = false;
  constructor(readonly id: number) {}
  close(): void {
    if (this.closed) throw new Error("double close");
    this.closed = true;
  }
}

/** <video> com rVFC controlado; `frame(perfMs)` dispara o callback registrado. */
class FakeVideo {
  private cb: VideoFrameRequestCallback | null = null;
  private nextHandle = 1;
  registrations = 0;
  requestVideoFrameCallback(cb: VideoFrameRequestCallback): number {
    this.cb = cb;
    this.registrations++;
    return this.nextHandle++;
  }
  cancelVideoFrameCallback(): void {
    this.cb = null;
  }
  frame(perfMs: number): void {
    const cb = this.cb;
    this.cb = null;
    cb?.(perfMs, { expectedDisplayTime: perfMs } as VideoFrameCallbackMetadata);
  }
  get armed(): boolean {
    return this.cb !== null;
  }
}

/** Relógio mock: procTime = perf/1000; gameTime controlável. */
const clock = {
  game: 0,
  procTimeAt: (perf: number) => perf / 1000,
  gameTime: () => clock.game,
};

let video: FakeVideo;
let bitmaps: FakeBitmap[];
/** Capturas pendentes: resolve na ordem com flush(). */
let pending: Array<() => void>;
let black: boolean;
let rms: number;

function setup(opts: Partial<VideoDelayOptions> = {}) {
  return createVideoDelay(video as unknown as HTMLVideoElement, clock, {
    createBitmap: () =>
      new Promise<ImageBitmap>((resolve) => {
        const b = new FakeBitmap(bitmaps.length);
        bitmaps.push(b);
        pending.push(() => resolve(b as unknown as ImageBitmap));
      }),
    isBlackFrame: () => black,
    ...opts,
  });
}

async function flush(): Promise<void> {
  const fns = pending.splice(0);
  for (const f of fns) f();
  await Promise.resolve();
  await Promise.resolve();
}

/** Um frame por vez, resolvendo a captura antes do próximo. */
async function feed(perfs: number[]): Promise<void> {
  for (const p of perfs) {
    video.frame(p);
    await flush();
  }
}

const id = (b: ImageBitmap | null) => (b as unknown as FakeBitmap | null)?.id ?? null;
const live = () => bitmaps.filter((b) => !b.closed).length;

beforeEach(() => {
  video = new FakeVideo();
  bitmaps = [];
  pending = [];
  black = false;
  rms = 0;
  clock.game = 0;
});

describe("captura", () => {
  it("start registra o rVFC e re-registra a cada callback; stop cancela", async () => {
    const d = setup();
    expect(video.armed).toBe(false);
    d.start();
    d.start(); // idempotente
    expect(video.registrations).toBe(1);
    await feed([1000, 1033]);
    expect(video.registrations).toBe(3);
    expect(video.armed).toBe(true);
    d.stop();
    expect(video.armed).toBe(false);
  });

  it("grava procTimeAt(expectedDisplayTime) + VIDEO_OFFSET_S", async () => {
    const d = setup();
    d.start();
    await feed([2000]);
    const t = 2 + CONFIG.VIDEO_OFFSET_S;
    expect(id(d.frameAt(t))).toBe(0);
    expect(d.frameAt(t - 0.001)).toBeNull();
  });

  it("captura pendente: descarta o frame novo (não enfileira)", async () => {
    const d = setup();
    d.start();
    video.frame(1000);
    video.frame(1033);
    video.frame(1066);
    expect(bitmaps).toHaveLength(1);
    expect(d.stats.droppedCaptures).toBe(2);
    await flush();
    await feed([1100]);
    expect(d.stats.frames).toBe(2);
  });

  it("ordena mesmo se a captura chegar fora de ordem de procTime", async () => {
    const d = setup();
    d.start();
    await feed([1000, 1100, 1050]); // ex.: correção da regressão do relógio
    expect(id(d.frameAt(1.06))).toBe(2);
    expect(id(d.frameAt(1.2))).toBe(1);
    expect(id(d.frameAt(1.01))).toBe(0);
  });
});

describe("frameAt", () => {
  it("devolve o último frame com procTime ≤ t (busca binária)", async () => {
    const d = setup();
    d.start();
    const perfs = Array.from({ length: 40 }, (_, i) => 1000 + i * 33);
    await feed(perfs);
    for (let i = 0; i < perfs.length; i++) {
      expect(id(d.frameAt(perfs[i]! / 1000))).toBe(i);
      expect(id(d.frameAt(perfs[i]! / 1000 + 0.02))).toBe(i);
    }
    expect(d.frameAt(0.999)).toBeNull();
    expect(id(d.frameAt(99))).toBe(39);
  });
});

describe("descarte", () => {
  it("fecha frames com procTime < gameTime − 0,1", async () => {
    const d = setup();
    d.start();
    await feed([1000, 1033, 1066, 1100, 1133]);
    clock.game = 1.2; // cutoff = 1.1
    await feed([1166]);
    expect(bitmaps.slice(0, 3).every((b) => b.closed)).toBe(true);
    expect(bitmaps.slice(3).every((b) => !b.closed)).toBe(true);
    expect(d.stats.frames).toBe(3);
  });

  it("mantém no máximo FRAME_BUFFER_S de histórico", async () => {
    const d = setup();
    d.start();
    clock.game = -100; // jogo ainda não alcançou: só o limite de histórico vale
    await feed(Array.from({ length: 100 }, (_, i) => 1000 + i * 33));
    const f = d.stats.frames;
    expect(f).toBeLessThanOrEqual(Math.ceil(CONFIG.FRAME_BUFFER_S / 0.033) + 1);
    expect(f).toBeGreaterThanOrEqual(Math.floor(CONFIG.FRAME_BUFFER_S / 0.033));
    expect(d.stats.approxBytes).toBe(f * CONFIG.FRAME_W * CONFIG.FRAME_H * 4);
  });

  it("acima do orçamento de memória, captura 1 a cada 2 frames", async () => {
    const d = setup();
    d.start();
    clock.game = -100;
    // 60 fps: 1,6s ≈ 96 frames ≈ 88 MB > 64 MB
    await feed(Array.from({ length: 120 }, (_, i) => 1000 + i * (1000 / 60)));
    expect(d.stats.decimated).toBe(true);
    const created = d.stats.created;
    await feed(Array.from({ length: 20 }, (_, i) => 3000 + i * (1000 / 60)));
    expect(d.stats.created - created).toBe(10);
    expect(d.stats.droppedCaptures).toBe(0);
  });

  it("sem vazamento em uso longo: criados − fechados = frames no buffer", async () => {
    const d = setup();
    d.start();
    // 10 min a 30 fps; gameTime = perf − DELAY_S
    for (let i = 0; i < 18_000; i++) {
      const perf = 1000 + i * (1000 / 30);
      clock.game = perf / 1000 - CONFIG.DELAY_S;
      await feed([perf]);
      d.frameAt(clock.game);
    }
    const s = d.stats;
    expect(s.created - s.closed).toBe(s.frames);
    expect(live()).toBe(s.frames);
    expect(s.frames).toBeLessThanOrEqual(Math.ceil(CONFIG.FRAME_BUFFER_S * 30) + 1);
    d.stop();
    expect(live()).toBe(0);
    expect(d.stats.created).toBe(d.stats.closed);
  });
});

describe("clear / stop", () => {
  it("após clear (seek) nenhum frame anterior aparece, nem um que estava pendente", async () => {
    const d = setup();
    d.start();
    clock.game = -100;
    await feed([1000, 1033, 1066]);
    video.frame(1100); // captura pendente do trecho antigo
    d.clear();
    expect(live()).toBe(1); // só a pendente, ainda não resolvida
    expect(d.frameAt(99)).toBeNull();
    // Trecho novo começa enquanto a antiga ainda está pendente: não é descartado.
    video.frame(5000);
    expect(d.stats.droppedCaptures).toBe(0);
    await flush();
    expect(bitmaps[3]!.closed).toBe(true);
    expect(id(d.frameAt(99))).toBe(4);
    expect(d.frameAt(4.99)).toBeNull();
    expect(video.armed).toBe(true); // continua capturando
  });

  it("stop libera tudo, inclusive capturas que resolvem depois", async () => {
    const d = setup();
    d.start();
    await feed([1000, 1033]);
    video.frame(1066);
    d.stop();
    await flush();
    expect(live()).toBe(0);
    expect(d.stats.frames).toBe(0);
    video.frame(1100); // nada registrado
    expect(bitmaps).toHaveLength(3);
  });

  it("pause: sem frames novos, o buffer permanece", async () => {
    const d = setup();
    d.start();
    clock.game = 0.9;
    await feed([1000, 1033]);
    // nenhum frame chega durante o pause; frameAt continua respondendo
    expect(id(d.frameAt(1.04))).toBe(1);
    expect(d.stats.frames).toBe(2);
  });
});

describe("detecção de DRM", () => {
  const withAudio = () => setup({ audioRms: () => rms });

  it("10 frames pretos com áudio → drmSuspected", async () => {
    const d = withAudio();
    d.start();
    black = true;
    rms = 0.1;
    await feed(Array.from({ length: CONFIG.DRM_CHECK_FRAMES - 1 }, (_, i) => 1000 + i * 33));
    expect(d.drmSuspected).toBe(false);
    await feed([2000]);
    expect(d.drmSuspected).toBe(true);
  });

  it("preto em silêncio não conta; um frame com imagem encerra a verificação", async () => {
    const d = withAudio();
    d.start();
    black = true;
    rms = 0;
    await feed(Array.from({ length: 30 }, (_, i) => 1000 + i * 33));
    expect(d.drmSuspected).toBe(false);
    black = false;
    await feed([3000]);
    black = true;
    rms = 0.1;
    await feed(Array.from({ length: 30 }, (_, i) => 4000 + i * 33));
    expect(d.drmSuspected).toBe(false);
  });

  it("suspeita é desfeita se aparecer imagem depois (re-verificação esparsa)", async () => {
    const d = withAudio();
    d.start();
    black = true;
    rms = 0.1;
    await feed(Array.from({ length: CONFIG.DRM_CHECK_FRAMES }, (_, i) => 1000 + i * 33));
    expect(d.drmSuspected).toBe(true);
    black = false;
    await feed(Array.from({ length: 30 }, (_, i) => 2000 + i * 33));
    expect(d.drmSuspected).toBe(false);
  });

  it("sem fonte de RMS, não verifica", async () => {
    const d = setup();
    d.start();
    black = true;
    await feed(Array.from({ length: 20 }, (_, i) => 1000 + i * 33));
    expect(d.drmSuspected).toBe(false);
  });
});

describe("continuidade (sem buracos)", () => {
  /** Vídeo a `fps`, rAF a 144 Hz, latência de saída `lat`; conta rAFs sem frame após o aquecimento. */
  async function gaps(fps: number, lat: number, displayAheadMs: number): Promise<number> {
    const d = setup();
    d.start();
    const raf = 1000 / 144;
    let nextFrame = 1000;
    let nulls = 0;
    for (let perf = 1000; perf < 1000 + 20_000; perf += raf) {
      clock.game = perf / 1000 - lat - CONFIG.DELAY_S;
      if (perf >= nextFrame) {
        video.frame(nextFrame + displayAheadMs);
        await flush();
        nextFrame += 1000 / fps;
      }
      if (perf > 1000 + 3000 && d.frameAt(clock.game) === null) nulls++;
    }
    return nulls;
  }

  it.each([
    [24, 0.05, 16],
    [30, 0.05, 16],
    [60, 0.05, 16],
    [30, 0.05, 40], // expectedDisplayTime bem adiantado: estourava o histórico de 1,6s
    [30, 0.2, 33], // Bluetooth
  ])("%i fps, latência %ss: frameAt(gameTime) nunca é null", async (fps, lat, ahead) => {
    expect(await gaps(fps, lat, ahead)).toBe(0);
  });

  it("buraco na captura (> 0,1s) não descarta o frame que está na tela", async () => {
    const d = setup();
    d.start();
    clock.game = 0.9;
    await feed([1000, 1033]);
    clock.game = 1.2; // a próxima captura só chega 250ms depois (capturas descartadas)
    await feed([1283]);
    expect(id(d.frameAt(1.2))).toBe(1);
    expect(bitmaps[0]!.closed).toBe(true);
  });
});
