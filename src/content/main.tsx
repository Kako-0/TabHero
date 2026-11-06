// Bootstrap do content script: encontra o player e injeta o botão placeholder.
import { DEBUG, error, log } from "@/shared/log";
import { AudioGraph, AudioGraphError } from "./audioGraph";
import { createClock } from "./clock";
import { isSoundOff, watchSound } from "./soundCheck";
import { mountOverlay, type OverlayHandle } from "./ui/mountOverlay";
import { findPlayer, isWatchPage, onNavigateFinish, type YouTubePlayer } from "./youtube";

let player: YouTubePlayer | null = null;
let overlay: OverlayHandle | null = null;
let graph: AudioGraph | null = null;
let stopSoundWatch: (() => void) | null = null;
let stopClockDebug: (() => void) | null = null;

/** M0 (spec 02, SPIKE 1): amostra o relógio a cada rAF e loga as duas fontes de latência. */
function startClockDebug(g: AudioGraph): () => void {
  // Janela de 10s do critério de aceite: desvio medido em todo frame.
  const newWin = (start: number) => ({ start, n: 0, sum: 0, sumAbs: 0, maxAbs: 0, latA: 0, latB: 0, nB: 0 });
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
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

function closeOverlay() {
  stopSoundWatch?.();
  stopSoundWatch = null;
  stopClockDebug?.();
  stopClockDebug = null;
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
      stopClockDebug = startClockDebug(g);
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
