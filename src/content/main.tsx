// Bootstrap do content script: encontra o player e injeta o botão placeholder.
import { error, log } from "@/shared/log";
import { loadWorkletProbe } from "./audioGraph";
import { mountOverlay, type OverlayHandle } from "./ui/mountOverlay";
import { findPlayer, isWatchPage, onNavigateFinish, type YouTubePlayer } from "./youtube";

let player: YouTubePlayer | null = null;
let overlay: OverlayHandle | null = null;

function closeOverlay() {
  overlay?.unmount();
  overlay = null;
  player?.unmountOverlayHost();
}

async function onPlayClick(p: YouTubePlayer) {
  if (overlay) {
    closeOverlay();
    return;
  }
  overlay = mountOverlay(p.mountOverlayHost());
  try {
    await loadWorkletProbe(p.video);
  } catch (e) {
    // Registrar no SPIKE 1 da spec 01.
    error("falha ao carregar o worklet", e);
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
