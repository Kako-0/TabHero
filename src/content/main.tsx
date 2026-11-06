// Bootstrap do content script: encontra o player e injeta o botão placeholder.
import { DEBUG, error, log } from "@/shared/log";
import { AudioGraph, AudioGraphError } from "./audioGraph";
import { isSoundOff, watchSound } from "./soundCheck";
import { mountOverlay, type OverlayHandle } from "./ui/mountOverlay";
import { findPlayer, isWatchPage, onNavigateFinish, type YouTubePlayer } from "./youtube";

let player: YouTubePlayer | null = null;
let overlay: OverlayHandle | null = null;
let graph: AudioGraph | null = null;
let stopSoundWatch: (() => void) | null = null;

function closeOverlay() {
  stopSoundWatch?.();
  stopSoundWatch = null;
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
    if (DEBUG) g.setMode("game");
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
