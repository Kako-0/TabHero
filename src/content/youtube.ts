// Todo seletor e detalhe do DOM do YouTube vive só aqui (spec 06).
import { STRINGS } from "@/shared/strings";

const SEL = {
  player: "#movie_player",
  video: "#movie_player video.html5-main-video",
  rightControls: "#movie_player .ytp-right-controls",
  /** "Próximo" da barra: playlist, mix ou o próximo do autoplay. */
  next: "#movie_player .ytp-next-button",
} as const;
const AD_CLASS = "ad-showing";
const NAVIGATE_START = "yt-navigate-start";
const NAVIGATE_FINISH = "yt-navigate-finish";

const FIND_TIMEOUT_MS = 10_000;
/** Verificação periódica de player-lost (o #movie_player pode sair do DOM sem mutação nele). */
const LOST_CHECK_MS = 1000;
const OVERLAY_HOST_ID = "tabhero-overlay-host";
const BUTTON_CLASS = "tabhero-play";
const ACTIVE_CLASS = "tabhero-active";
const STYLE_ID = "tabhero-style";

const P = `#movie_player.${ACTIVE_CLASS}`;
const ACTIVE_CSS = `
${P} video.html5-main-video { opacity: 0 !important; }
${P} .ytp-chrome-top,
${P} .ytp-chrome-bottom,
${P} .ytp-gradient-top,
${P} .ytp-gradient-bottom,
${P} .ytp-caption-window-container,
${P} .ytp-paid-content-overlay,
${P} .ytp-ce-element { display: none !important; }
/* Anúncio: o vídeo do anúncio aparece ao vivo e os cliques atravessam o overlay
   ("Pular anúncio" continua visível e clicável; .ytp-ad-* nunca é escondido). */
${P}.${AD_CLASS} video.html5-main-video { opacity: 1 !important; }
#movie_player.${AD_CLASS} > #${OVERLAY_HOST_ID} { pointer-events: none !important; }
`;

/** Eventos de mouse que não podem chegar ao player (clique = play/pause, duplo = tela cheia). */
const SWALLOWED_MOUSE_EVENTS = [
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "contextmenu",
] as const;

export type PlayerEvent = "ad-start" | "ad-end" | "navigate" | "player-lost";

export interface YouTubePlayer {
  readonly video: HTMLVideoElement;
  readonly playerEl: HTMLElement; // #movie_player
  readonly videoId: string | null;
  isAdShowing(): boolean;
  /** Existe próximo vídeo (playlist, mix ou sugestão do autoplay)? */
  hasNext(): boolean;
  /** Vai para o próximo vídeo pelo botão do YouTube. Devolve false se não houver. */
  goNext(): boolean;
  /** Cria (ou reaproveita) o host do overlay dentro do #movie_player. */
  mountOverlayHost(): HTMLElement;
  unmountOverlayHost(): void;
  /** Classe CSS no #movie_player: esconde o vídeo e os controles nativos. */
  setGameActive(active: boolean): void;
  injectPlayButton(onClick: () => void): void;
  /** Devolve a função de cancelamento. */
  on(ev: PlayerEvent, fn: () => void): () => void;
  dispose(): void;
}

export function isWatchPage(): boolean {
  return location.pathname === "/watch";
}

export function onNavigateFinish(fn: () => void): () => void {
  document.addEventListener(NAVIGATE_FINISH, fn);
  return () => document.removeEventListener(NAVIGATE_FINISH, fn);
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
  const listeners = new Map<PlayerEvent, Set<() => void>>();
  const emit = (ev: PlayerEvent) => {
    for (const fn of [...(listeners.get(ev) ?? [])]) fn();
  };

  let onPlayClick: (() => void) | null = null;
  let adShowing = playerEl.classList.contains(AD_CLASS);
  let lost = false;

  const isLost = () =>
    !playerEl.isConnected ||
    !video.isConnected ||
    document.querySelector<HTMLVideoElement>(SEL.video) !== video;
  const checkLost = () => {
    if (lost || !isLost()) return;
    lost = true;
    emit("player-lost");
  };

  const injectButton = () => {
    if (!onPlayClick) return;
    const controls = document.querySelector<HTMLElement>(SEL.rightControls);
    if (!controls || controls.querySelector(`.${BUTTON_CLASS}`)) return;
    const click = onPlayClick;
    const btn = document.createElement("button");
    btn.className = `ytp-button ${BUTTON_CLASS}`;
    btn.title = STRINGS.playButtonTooltip;
    btn.setAttribute("aria-label", STRINGS.playButtonTooltip);
    btn.innerHTML = PLAY_ICON_SVG;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      click();
    });
    controls.prepend(btn);
  };

  // Anúncio: classe `ad-showing` no #movie_player.
  const adObserver = new MutationObserver(() => {
    const now = playerEl.classList.contains(AD_CLASS);
    if (now === adShowing) return;
    adShowing = now;
    emit(now ? "ad-start" : "ad-end");
  });
  adObserver.observe(playerEl, { attributes: true, attributeFilter: ["class"] });

  // O YouTube re-renderiza a barra (reinjeta o botão) e pode trocar o <video>.
  const domObserver = new MutationObserver(() => {
    injectButton();
    checkLost();
  });
  domObserver.observe(playerEl, { childList: true, subtree: true });
  const lostTimer = setInterval(checkLost, LOST_CHECK_MS);

  const onNavigateStart = () => emit("navigate");
  document.addEventListener(NAVIGATE_START, onNavigateStart);

  const stopMouse = (e: Event) => e.stopPropagation();

  /** O YouTube esconde o botão com display:none inline (não por CSS) quando não há próximo. */
  const nextButton = (): HTMLElement | null => {
    const btn = document.querySelector<HTMLElement>(SEL.next);
    if (!btn || btn.style.display === "none" || btn.getAttribute("aria-disabled") === "true")
      return null;
    return btn;
  };

  return {
    video,
    playerEl,
    get videoId() {
      return new URLSearchParams(location.search).get("v");
    },
    isAdShowing() {
      return playerEl.classList.contains(AD_CLASS);
    },
    hasNext() {
      return nextButton() !== null;
    },
    goNext() {
      const btn = nextButton();
      btn?.click();
      return btn !== null;
    },
    mountOverlayHost() {
      let host = playerEl.querySelector<HTMLElement>(`#${OVERLAY_HOST_ID}`);
      if (!host) {
        host = document.createElement("div");
        host.id = OVERLAY_HOST_ID;
        host.style.cssText = "position:absolute;inset:0;z-index:70;";
        for (const ev of SWALLOWED_MOUSE_EVENTS) host.addEventListener(ev, stopMouse);
        playerEl.appendChild(host);
      }
      return host;
    },
    unmountOverlayHost() {
      playerEl.querySelector(`#${OVERLAY_HOST_ID}`)?.remove();
    },
    injectPlayButton(onClick) {
      onPlayClick = onClick;
      injectButton();
    },
    setGameActive(active) {
      if (active && !document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = ACTIVE_CSS;
        document.head.appendChild(style);
      }
      playerEl.classList.toggle(ACTIVE_CLASS, active);
    },
    on(ev, fn) {
      let set = listeners.get(ev);
      if (!set) listeners.set(ev, (set = new Set()));
      set.add(fn);
      return () => void set.delete(fn);
    },
    dispose() {
      playerEl.classList.remove(ACTIVE_CLASS);
      adObserver.disconnect();
      domObserver.disconnect();
      clearInterval(lostTimer);
      document.removeEventListener(NAVIGATE_START, onNavigateStart);
      listeners.clear();
      onPlayClick = null;
      // O clique do botão aponta para este player: o próximo injeta o seu.
      document.querySelector(`${SEL.rightControls} .${BUTTON_CLASS}`)?.remove();
    },
  };
}

// ── Escudo de teclado ────────────────────────────────────────────────────────

/** Teclas que nunca são interceptadas: navegação por foco e teclas de função (F5, F11, F12…). */
const PASS_THROUGH_CODE = /^(Tab|F\d{1,2})$/;

type KeyTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

function isEditable(el: unknown): boolean {
  if (!el || typeof el !== "object") return false;
  const e = el as Partial<HTMLElement>;
  if (e.isContentEditable) return true;
  const tag = e.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Decide se o escudo engole a tecla. `playerEl`: campos editáveis dentro dele (overlay)
 * continuam interceptados; fora dele (ex.: busca do YouTube), não.
 */
export function shouldShield(e: KeyboardEvent, playerEl: Pick<Node, "contains"> | null): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (PASS_THROUGH_CODE.test(e.code)) return false;
  // composedPath()[0]: o alvo real, mesmo dentro de Shadow DOM (o e.target é retargetado).
  const target = (e.composedPath?.()[0] ?? e.target) as unknown;
  if (isEditable(target) && !playerEl?.contains(target as Node)) return false;
  return true;
}

/**
 * Captura keydown/keyup em `window` (fase de captura), antes dos atalhos do YouTube.
 * As teclas interceptadas vão só para `handler`. Devolve a função que remove o escudo.
 */
export function installKeyboardShield(
  handler: (e: KeyboardEvent) => void,
  target: KeyTarget = window,
  getPlayerEl: () => Pick<Node, "contains"> | null = () => document.querySelector(SEL.player),
): () => void {
  const onKey = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (!shouldShield(ke, getPlayerEl())) return;
    ke.preventDefault();
    ke.stopImmediatePropagation();
    handler(ke);
  };
  target.addEventListener("keydown", onKey, { capture: true });
  target.addEventListener("keyup", onKey, { capture: true });
  return () => {
    target.removeEventListener("keydown", onKey, { capture: true });
    target.removeEventListener("keyup", onKey, { capture: true });
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
