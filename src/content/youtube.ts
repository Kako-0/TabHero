// Todo seletor e detalhe do DOM do YouTube vive só aqui (spec 06).
// Setup: findPlayer() + botão placeholder + host do overlay. O resto entra no M2.
import { STRINGS } from "@/shared/strings";

const SEL = {
  player: "#movie_player",
  video: "#movie_player video.html5-main-video",
  rightControls: "#movie_player .ytp-right-controls",
} as const;

const FIND_TIMEOUT_MS = 10_000;
const OVERLAY_HOST_ID = "tabhero-overlay-host";
const BUTTON_CLASS = "tabhero-play";

export interface YouTubePlayer {
  readonly video: HTMLVideoElement;
  readonly playerEl: HTMLElement;
  readonly videoId: string | null;
  /** Cria (ou reaproveita) o host do overlay dentro do #movie_player. */
  mountOverlayHost(): HTMLElement;
  unmountOverlayHost(): void;
  injectPlayButton(onClick: () => void): void;
  dispose(): void;
}

export function isWatchPage(): boolean {
  return location.pathname === "/watch";
}

export function onNavigateFinish(fn: () => void): () => void {
  document.addEventListener("yt-navigate-finish", fn);
  return () => document.removeEventListener("yt-navigate-finish", fn);
}

/** Espera o #movie_player e o <video> aparecerem (até 10s). */
export function findPlayer(): Promise<YouTubePlayer> {
  return new Promise((resolve, reject) => {
    const tryFind = (): boolean => {
      const playerEl = document.querySelector<HTMLElement>(SEL.player);
      const video = document.querySelector<HTMLVideoElement>(SEL.video);
      if (!playerEl || !video) return false;
      resolve(createPlayer(playerEl, video));
      return true;
    };
    if (tryFind()) return;
    const obs = new MutationObserver(() => {
      if (tryFind()) cleanup();
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("player não encontrado"));
    }, FIND_TIMEOUT_MS);
    const cleanup = () => {
      obs.disconnect();
      clearTimeout(timer);
    };
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function createPlayer(playerEl: HTMLElement, video: HTMLVideoElement): YouTubePlayer {
  let buttonObserver: MutationObserver | null = null;

  const injectButton = (onClick: () => void) => {
    const controls = document.querySelector<HTMLElement>(SEL.rightControls);
    if (!controls || controls.querySelector(`.${BUTTON_CLASS}`)) return;
    const btn = document.createElement("button");
    btn.className = `ytp-button ${BUTTON_CLASS}`;
    btn.title = STRINGS.playButtonTooltip;
    btn.setAttribute("aria-label", STRINGS.playButtonTooltip);
    btn.innerHTML = PLAY_ICON_SVG;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    controls.prepend(btn);
  };

  return {
    video,
    playerEl,
    get videoId() {
      return new URLSearchParams(location.search).get("v");
    },
    mountOverlayHost() {
      let host = playerEl.querySelector<HTMLElement>(`#${OVERLAY_HOST_ID}`);
      if (!host) {
        host = document.createElement("div");
        host.id = OVERLAY_HOST_ID;
        host.style.cssText = "position:absolute;inset:0;z-index:70;";
        playerEl.appendChild(host);
      }
      return host;
    },
    unmountOverlayHost() {
      playerEl.querySelector(`#${OVERLAY_HOST_ID}`)?.remove();
    },
    injectPlayButton(onClick) {
      injectButton(onClick);
      // O YouTube re-renderiza a barra; reinjeta se o botão sumir.
      buttonObserver?.disconnect();
      buttonObserver = new MutationObserver(() => injectButton(onClick));
      buttonObserver.observe(playerEl, { childList: true, subtree: true });
    },
    dispose() {
      buttonObserver?.disconnect();
      buttonObserver = null;
    },
  };
}

// Ícone próprio: quatro barras (pistas) com uma nota.
const PLAY_ICON_SVG = `<svg viewBox="0 0 36 36" width="100%" height="100%" aria-hidden="true">
  <g fill="#fff">
    <rect x="9" y="10" width="3" height="16" rx="1" opacity=".55"/>
    <rect x="14" y="10" width="3" height="16" rx="1" opacity=".55"/>
    <rect x="19" y="10" width="3" height="16" rx="1" opacity=".55"/>
    <rect x="24" y="10" width="3" height="16" rx="1" opacity=".55"/>
    <rect x="13" y="16" width="5" height="4" rx="1.5"/>
  </g>
</svg>`;
