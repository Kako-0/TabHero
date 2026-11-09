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
.tabhero-hint { margin: 16px 0 0; font-size: 13px; color: #d4d4d4; }
`;

export interface OverlayHandle {
  /** Canvas do jogo (spec 07), atrás da UI React. */
  readonly canvas: HTMLCanvasElement;
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

  return {
    canvas,
    update(next) {
      root.render(<App {...next} />);
    },
    unmount() {
      root.unmount();
      shadow.replaceChildren();
    },
  };
}
