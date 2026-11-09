// Vídeo atrasado (spec 03): captura os frames do <video> com o procTime em que foram
// exibidos e devolve, a cada render, o frame correspondente a gameTime (= DELAY_S atrás).
import type { GameClock } from "@/content/clock";
import { CONFIG } from "@/shared/config";
import { warn } from "@/shared/log";

export interface VideoDelayStats {
  frames: number;
  approxBytes: number;
  /** Frames descartados porque a captura anterior ainda estava pendente. */
  droppedCaptures: number;
  /** Bitmaps criados / fechados (vazamento: created − closed > frames). */
  created: number;
  closed: number;
  /** Orçamento estourado: captura 1 a cada 2 frames até o stop(). */
  decimated: boolean;
}

export interface VideoDelayBuffer {
  start(): void; // começa a capturar (requestVideoFrameCallback)
  stop(): void; // para e libera todos os frames
  clear(): void; // libera os frames (seek/flush); continua capturando
  /** Frame mais recente com procTime ≤ t, ou null. */
  frameAt(t: number): ImageBitmap | null;
  readonly drmSuspected: boolean;
  readonly stats: VideoDelayStats;
}

export interface VideoDelayOptions {
  /** RMS do áudio sem atraso (para a detecção de DRM). Ausente: DRM não é verificado. */
  audioRms?: () => number;
  /** Injetáveis para testes. */
  createBitmap?: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  isBlackFrame?: (video: HTMLVideoElement) => boolean;
}

type FrameVideo = Pick<HTMLVideoElement, "requestVideoFrameCallback" | "cancelVideoFrameCallback">;

interface Frame {
  procTime: number;
  bitmap: ImageBitmap;
}

const BYTES_PER_FRAME = CONFIG.FRAME_W * CONFIG.FRAME_H * 4;
/** Frames mais antigos que gameTime − isso não serão mais pedidos. */
const KEEP_BEHIND_S = 0.1;
/** Depois de suspeitar de DRM, re-verifica 1 a cada N frames (um frame não preto desfaz). */
const DRM_RECHECK_EVERY = 30;

function defaultCreateBitmap(video: HTMLVideoElement): Promise<ImageBitmap> {
  return createImageBitmap(video, {
    resizeWidth: CONFIG.FRAME_W,
    resizeHeight: CONFIG.FRAME_H,
    resizeQuality: "low",
  });
}

let probe: OffscreenCanvasRenderingContext2D | null = null;

/** Amostra 16 pixels (4×4). Erro de leitura conta como "não preto" (sem falso positivo). */
function defaultIsBlackFrame(video: HTMLVideoElement): boolean {
  try {
    probe ??= new OffscreenCanvas(4, 4).getContext("2d", { willReadFrequently: true });
    if (!probe) return false;
    probe.drawImage(video, 0, 0, 4, 4);
    const px = probe.getImageData(0, 0, 4, 4).data;
    for (let i = 0; i < px.length; i += 4) {
      if (
        px[i]! > CONFIG.DRM_BLACK_MAX ||
        px[i + 1]! > CONFIG.DRM_BLACK_MAX ||
        px[i + 2]! > CONFIG.DRM_BLACK_MAX
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function createVideoDelay(
  video: HTMLVideoElement,
  clock: Pick<GameClock, "procTimeAt" | "gameTime">,
  opts: VideoDelayOptions = {},
): VideoDelayBuffer {
  const v = video as FrameVideo;
  const createBitmap = opts.createBitmap ?? defaultCreateBitmap;
  const isBlackFrame = opts.isBlackFrame ?? defaultIsBlackFrame;

  /** Ordenado por procTime. */
  const frames: Frame[] = [];
  let running = false;
  let handle: number | null = null;
  let pending = false;
  /** Incrementada em clear/stop: capturas pendentes de antes são descartadas ao resolver. */
  let generation = 0;
  let frameCount = 0;
  let decimated = false;
  let droppedCaptures = 0;
  let created = 0;
  let closed = 0;

  // DRM: "checking" até 10 pretos seguidos com áudio (→ suspected) ou um frame com imagem (→ done).
  let drmState: "checking" | "suspected" | "done" = opts.audioRms ? "checking" : "done";
  let blackWithAudio = 0;
  let failWarned = false;

  function close(bitmap: ImageBitmap): void {
    bitmap.close();
    closed++;
  }

  function releaseAll(): void {
    for (const f of frames) close(f.bitmap);
    frames.length = 0;
  }

  /** Índice do último frame com procTime ≤ t, ou −1. */
  function lastAtOrBefore(t: number): number {
    let lo = 0;
    let hi = frames.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid]!.procTime <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function insert(f: Frame): void {
    // Quase sempre no fim; ordem só se inverte com correções da regressão do relógio.
    const i = lastAtOrBefore(f.procTime) + 1;
    if (i === frames.length) frames.push(f);
    else frames.splice(i, 0, f);
  }

  function prune(): void {
    const newest = frames[frames.length - 1];
    if (!newest) return;
    const t = clock.gameTime();
    const cutoff = Math.max(t - KEEP_BEHIND_S, newest.procTime - CONFIG.FRAME_BUFFER_S);
    // O frame que frameAt(gameTime) devolve agora (e os seguintes) nunca sai: com um buraco
    // na captura ou histórico curto, descartá-lo deixaria a tela sem frame (piscada).
    const current = lastAtOrBefore(t);
    const limit = current < 0 ? frames.length : current;
    let n = 0;
    while (n < limit && frames[n]!.procTime < cutoff) close(frames[n++]!.bitmap);
    if (n) frames.splice(0, n);
    if (!decimated && frames.length * BYTES_PER_FRAME > CONFIG.FRAME_BUDGET_BYTES) {
      decimated = true;
      warn("vídeo atrasado: orçamento de memória estourado, capturando 1 a cada 2 frames", {
        frames: frames.length,
      });
    }
  }

  function checkDrm(): void {
    if (drmState === "done") return;
    if (drmState === "suspected") {
      if (frameCount % DRM_RECHECK_EVERY === 0 && !isBlackFrame(video)) drmState = "done";
      return;
    }
    if (!isBlackFrame(video)) {
      drmState = "done";
      return;
    }
    // Preto em silêncio (intro, fade) não diz nada: só conta preto com som.
    if (opts.audioRms!() <= CONFIG.DRM_AUDIO_RMS) return;
    if (++blackWithAudio >= CONFIG.DRM_CHECK_FRAMES) {
      drmState = "suspected";
      warn("vídeo atrasado: frames pretos com áudio, suspeita de DRM");
    }
  }

  const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
    if (!running) return;
    handle = v.requestVideoFrameCallback(onFrame);
    frameCount++;
    checkDrm();
    if (decimated && frameCount % 2) return;
    if (pending) {
      droppedCaptures++;
      return;
    }
    const procTime = clock.procTimeAt(metadata.expectedDisplayTime) + CONFIG.VIDEO_OFFSET_S;
    const gen = generation;
    pending = true;
    createBitmap(video).then(
      (bitmap) => {
        // Uma captura de antes do clear() não mexe na vaga da geração atual.
        if (gen === generation) pending = false;
        created++;
        if (gen !== generation || !running) return close(bitmap);
        insert({ procTime, bitmap });
        prune();
      },
      (e: unknown) => {
        if (gen === generation) pending = false;
        if (!failWarned) warn("vídeo atrasado: falha no createImageBitmap", e);
        failWarned = true;
      },
    );
  };

  return {
    start() {
      if (running) return;
      running = true;
      handle = v.requestVideoFrameCallback(onFrame);
    },
    stop() {
      running = false;
      if (handle !== null) v.cancelVideoFrameCallback(handle);
      handle = null;
      generation++;
      pending = false;
      decimated = false;
      releaseAll();
    },
    clear() {
      generation++;
      // Uma captura pendente da geração anterior é fechada ao resolver; libera a vaga já.
      pending = false;
      releaseAll();
    },
    frameAt(t) {
      const i = lastAtOrBefore(t);
      return i < 0 ? null : frames[i]!.bitmap;
    },
    get drmSuspected() {
      return drmState === "suspected";
    },
    get stats() {
      return {
        frames: frames.length,
        approxBytes: frames.length * BYTES_PER_FRAME,
        droppedCaptures,
        created,
        closed,
        decimated,
      };
    },
  };
}
