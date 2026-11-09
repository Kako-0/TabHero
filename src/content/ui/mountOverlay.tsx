import { createRoot, type Root } from "react-dom/client";
import { App, type AppProps } from "./App";

const CSS = `
/* O overlay captura os cliques (o host engole os eventos de mouse antes do player);
   durante anúncio, youtube.ts põe pointer-events:none no host (spec 06). */
:host { all: initial; }
#game { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.root {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: system-ui, sans-serif; color: #fff;
}
.tabhero-banner {
  position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
  max-width: calc(100% - 32px); box-sizing: border-box;
  padding: 8px 16px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.85); color: #fde047;
  font-size: 16px; font-weight: 600; text-align: center;
}
.tabhero-ad { color: #fff; font-weight: 500; }
.tabhero-big {
  font-size: 96px; font-weight: 800;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.7);
}
.tabhero-msg { font-size: 28px; font-weight: 600; text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7); }
.tabhero-panel {
  min-width: 260px; max-width: calc(100% - 32px); box-sizing: border-box;
  padding: 20px 24px; border-radius: 12px; background: rgba(0, 0, 0, 0.85);
  text-align: center; font-size: 16px;
}
.tabhero-panel h2 { margin: 0 0 12px; font-size: 28px; }
.tabhero-panel dl {
  display: grid; grid-template-columns: auto auto; gap: 4px 16px; margin: 0 0 16px;
  text-align: left;
}
.tabhero-panel dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.tabhero-buttons { display: flex; gap: 12px; justify-content: center; }
.tabhero-buttons button {
  font: inherit; font-weight: 600; padding: 8px 20px; border-radius: 8px; cursor: pointer;
  border: 2px solid #fff; background: transparent; color: #fff;
}
.tabhero-buttons button:first-child { background: #fff; color: #000; }
.tabhero-buttons button:focus-visible { outline: 3px solid #fde047; outline-offset: 2px; }
.tabhero-buttons kbd {
  font: inherit; font-size: 12px; font-weight: 600; margin-left: 6px;
  padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; opacity: 0.75;
}
.tabhero-sync { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.tabhero-bar {
  width: 240px; max-width: 60vw; height: 6px; border-radius: 3px; overflow: hidden;
  background: rgba(255, 255, 255, 0.25);
}
.tabhero-bar > div {
  height: 100%; width: 100%; background: #fff; transform-origin: left;
  animation: tabhero-fill linear forwards;
}
@keyframes tabhero-fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.tabhero-hint { margin: 16px 0 0; font-size: 13px; color: #d4d4d4; }
`;

/** Resolução do canvas: tamanho CSS × devicePixelRatio, limitado a 2. */
const MAX_DPR = 2;

export interface OverlayHandle {
  /** Canvas do jogo (spec 07), atrás da UI React. Redimensionado com o host (ResizeObserver). */
  readonly canvas: HTMLCanvasElement;
  /** Chamado depois de cada redimensionamento do canvas (que apaga o conteúdo). */
  onResize(fn: () => void): void;
  update(props: AppProps): void;
  unmount(): void;
}

/** Monta o React num Shadow DOM dentro de `host` (CSS isolado do YouTube). */
export function mountOverlay(host: HTMLElement, props: AppProps): OverlayHandle {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = CSS;
  const canvas = document.createElement("canvas");
  canvas.id = "game";
  const container = document.createElement("div");
  container.className = "root";
  container.id = "ui-root";
  shadow.append(style, canvas, container);

  const root: Root = createRoot(container);
  root.render(<App {...props} />);

  const resizeListeners: (() => void)[] = [];
  const ro = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentRect;
    if (!box) return;
    const dpr = Math.min(MAX_DPR, devicePixelRatio || 1);
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    for (const fn of resizeListeners) fn();
  });
  ro.observe(host);

  return {
    canvas,
    onResize(fn) {
      resizeListeners.push(fn);
    },
    update(next) {
      root.render(<App {...next} />);
    },
    unmount() {
      ro.disconnect();
      resizeListeners.length = 0;
      root.unmount();
      shadow.replaceChildren();
    },
  };
}
