import { createRoot, type Root } from "react-dom/client";
import { App, type AppProps } from "./App";

const CSS = `
/* Setup: o placeholder deixa os cliques passarem, para o botão da barra
   continuar clicável (2º clique fecha). No M2 o overlay passa a capturar
   cliques e a saída é pelo menu de pausa (spec 06/07). */
:host { all: initial; pointer-events: none; }
.root {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  font-family: system-ui, sans-serif;
}
.tabhero-banner {
  position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
  max-width: calc(100% - 32px); box-sizing: border-box;
  padding: 8px 16px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.85); color: #fde047;
  font-size: 16px; font-weight: 600; text-align: center;
}
.tabhero-placeholder {
  color: #fff; font-size: 48px; font-weight: 700; letter-spacing: 0.05em;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
}
`;

export interface OverlayHandle {
  update(props: AppProps): void;
  unmount(): void;
}

/** Monta o React num Shadow DOM dentro de `host` (CSS isolado do YouTube). */
export function mountOverlay(host: HTMLElement, props: AppProps): OverlayHandle {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = CSS;
  const container = document.createElement("div");
  container.className = "root";
  container.id = "ui-root";
  shadow.append(style, container);

  const root: Root = createRoot(container);
  root.render(<App {...props} />);

  return {
    update(next) {
      root.render(<App {...next} />);
    },
    unmount() {
      root.unmount();
      shadow.replaceChildren();
    },
  };
}
