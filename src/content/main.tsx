// Bootstrap do content script: encontra o player e injeta o botão placeholder.
import { DEBUG, error, log, warn } from "@/shared/log";
import { AudioGraph, AudioGraphError } from "./audioGraph";
import { createClock, type GameClock } from "./clock";
import { isSoundOff, watchSound } from "./soundCheck";
import { createVideoDelay } from "./videoDelay";
import { mountOverlay, type OverlayHandle } from "./ui/mountOverlay";
import { findPlayer, isWatchPage, onNavigateFinish, type YouTubePlayer } from "./youtube";

let player: YouTubePlayer | null = null;
let overlay: OverlayHandle | null = null;
let graph: AudioGraph | null = null;
let stopSoundWatch: (() => void) | null = null;
let stopDebug: (() => void) | null = null;

/** M0 (spec 02, SPIKE 1): amostra o relógio a cada rAF e loga as duas fontes de latência. */
function startClockDebug(
  g: AudioGraph,
  onTick?: (clock: GameClock, now: number) => void,
): { clock: GameClock; stop: () => void } {
  // Janela de 10s do critério de aceite: desvio medido em todo frame.
  const newWin = (start: number) => ({
    start,
    n: 0,
    sum: 0,
    sumAbs: 0,
    maxAbs: 0,
    latA: 0,
    latB: 0,
    nB: 0,
  });
  let win = newWin(performance.now());
  let winDirty = false; // houve resync/suspensão na janela → descarta
  const clock = createClock(g, {
    onResync: (reason) => {
      winDirty = true;
      log("relógio: resync", { reason });
    },
  });
  let raf = 0;
  let lastLog = 0;
  const tick = (now: number) => {
    clock.sample();
    if (g.ctx.state !== "running") {
      winDirty = true;
    } else {
      // Mesmo instante dos dois lados: o `now` do rAF é anterior à leitura do currentTime.
      const p = performance.now();
      const d = (clock.procTimeAt(p) - g.ctx.currentTime) * 1000;
      const { outputLatency, outputTimestamp } = clock.latencySources();
      win.n++;
      win.sum += d;
      win.sumAbs += Math.abs(d);
      win.maxAbs = Math.max(win.maxAbs, Math.abs(d));
      win.latA += outputLatency * 1000;
      if (outputTimestamp !== null) {
        win.latB += outputTimestamp * 1000;
        win.nB++;
      }
    }
    if (now - win.start >= 10_000) {
      if (winDirty) {
        log("relógio 10s: janela descartada (resync/suspensão)", { n: win.n });
      } else if (win.n > 0) {
        log("relógio 10s", {
          n: win.n,
          driftMeanMs: (win.sum / win.n).toFixed(2),
          driftMeanAbsMs: (win.sumAbs / win.n).toFixed(2),
          driftMaxAbsMs: win.maxAbs.toFixed(2),
          latencyA_ms: (win.latA / win.n).toFixed(2),
          latencyB_ms: win.nB ? (win.latB / win.nB).toFixed(2) : null,
        });
      }
      win = newWin(now);
      winDirty = false;
    }
    if (now - lastLog >= 2000) {
      lastLog = now;
      const { outputLatency, outputTimestamp } = clock.latencySources();
      log("relógio", {
        gameTime: clock.gameTime().toFixed(3),
        driftMs: ((clock.procTimeAt(performance.now()) - g.ctx.currentTime) * 1000).toFixed(2),
        latencyA_ms: (outputLatency * 1000).toFixed(1),
        latencyB_ms: outputTimestamp === null ? null : (outputTimestamp * 1000).toFixed(1),
      });
    }
    onTick?.(clock, now);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { clock, stop: () => cancelAnimationFrame(raf) };
}

/**
 * M0 (spec 03): esconde o <video> e desenha o vídeo atrasado num canvas atrás do overlay.
 * Seek → flush + clear + resync (o que a spec 05 fará no SYNCING). Loga stats a cada 2s.
 */
function startVideoDebug(p: YouTubePlayer, g: AudioGraph, host: HTMLElement): () => void {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  host.shadowRoot?.prepend(canvas);
  const c2d = canvas.getContext("2d", { alpha: false })!;
  let drawn: ImageBitmap | null = null;
  let dimmed = false;
  /** Frame → sem frame fora de seek/início: cada um é uma piscada visível. */
  let gaps = 0;
  let expectGap = true;
  let lastLog = 0;

  const { clock, stop: stopClock } = startClockDebug(g, (clk, now) => {
    const dpr = Math.min(2, devicePixelRatio);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      drawn = null;
    }
    const frame = vd.frameAt(clk.gameTime());
    if (frame && frame !== drawn) {
      // cover
      const s = Math.max(w / frame.width, h / frame.height);
      const fw = frame.width * s;
      const fh = frame.height * s;
      c2d.drawImage(frame, (w - fw) / 2, (h - fh) / 2, fw, fh);
      drawn = frame;
      dimmed = false;
      expectGap = false;
    } else if (!frame && !dimmed) {
      if (!expectGap) {
        gaps++;
        warn("vídeo atrasado: sem frame (piscada)", { gameTime: clk.gameTime().toFixed(3) });
      }
      // Sem frame (início / após seek): mantém o último desenhado, escurecido (spec 07).
      c2d.fillStyle = "rgba(0,0,0,0.5)";
      c2d.fillRect(0, 0, w, h);
      dimmed = true;
      drawn = null;
    }
    if (now - lastLog >= 2000) {
      lastLog = now;
      const st = vd.stats;
      log("vídeo atrasado", {
        ...st,
        approxMB: (st.approxBytes / 2 ** 20).toFixed(1),
        leak: st.created - st.closed - st.frames,
        gaps,
        drmSuspected: vd.drmSuspected,
      });
    }
  });

  // Definido antes do 1º rAF (o tick acima só roda no próximo frame).
  const vd = createVideoDelay(p.video, clock, { audioRms: () => g.inputRms() });
  const onSeeking = () => {
    expectGap = true;
    g.flush();
    vd.clear();
    clock.resync();
    log("vídeo atrasado: seek → flush/clear/resync");
  };
  p.video.addEventListener("seeking", onSeeking);
  p.setGameActive(true);
  vd.start();

  return () => {
    stopClock();
    vd.stop();
    p.video.removeEventListener("seeking", onSeeking);
    p.setGameActive(false);
    canvas.remove();
  };
}

function closeOverlay() {
  stopSoundWatch?.();
  stopSoundWatch = null;
  stopDebug?.();
  stopDebug = null;
  graph?.dispose();
  graph = null;
  overlay?.unmount();
  overlay = null;
  player?.unmountOverlayHost();
}

async function onPlayClick(p: YouTubePlayer) {
  if (overlay) {
    closeOverlay();
    return;
  }
  const ov = mountOverlay(p.mountOverlayHost(), { soundOff: isSoundOff(p.video) });
  overlay = ov;
  stopSoundWatch = watchSound(p.video, (soundOff) => ov.update({ soundOff }));
  try {
    const g = await AudioGraph.attach(p.video);
    if (!overlay) return g.dispose(); // fechado durante o attach
    graph = g;
    // M0: em dev, liga o modo de jogo direto para medir o atraso (spec 01, teste manual).
    if (DEBUG) {
      g.setMode("game");
      stopDebug = startVideoDebug(p, g, p.mountOverlayHost());
    }
  } catch (e) {
    // A UI de erro (07) mostra STRINGS.errors[e.code].
    if (e instanceof AudioGraphError) error("grafo de áudio:", e.code, e.cause);
    else error("grafo de áudio:", e);
  }
}

async function bootstrap() {
  closeOverlay();
  player?.dispose();
  player = null;
  if (!isWatchPage()) return;
  try {
    const p = await findPlayer();
    player = p;
    p.injectPlayButton(() => void onPlayClick(p));
    log("botão injetado", p.videoId);
  } catch (e) {
    error(e);
  }
}

onNavigateFinish(() => void bootstrap());
void bootstrap();
