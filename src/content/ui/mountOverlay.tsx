import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";

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
.tabhero-placeholder {
  color: #fff; font-size: 48px; font-weight: 700; letter-spacing: 0.05em;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
}
`;

export interface OverlayHandle {
  unmount(): void;
}

/** Monta o React num Shadow DOM dentro de `host` (CSS isolado do YouTube). */
export function mountOverlay(host: HTMLElement): OverlayHandle {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = CSS;
  const container = document.createElement("div");
  container.className = "root";
  container.id = "ui-root";
  shadow.append(style, container);

  const root: Root = createRoot(container);
  root.render(<App />);

  return {
    unmount() {
      root.unmount();
      shadow.replaceChildren();
    },
  };
}
