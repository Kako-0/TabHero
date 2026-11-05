import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "TabHero",
  version: pkg.version,
  description: "Jogo de ritmo gerado ao vivo a partir do áudio de vídeos do YouTube.",
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  permissions: ["storage"],
  host_permissions: ["https://www.youtube.com/*"],
  background: { service_worker: "src/background.ts", type: "module" },
  content_scripts: [
    {
      matches: ["https://www.youtube.com/*"],
      js: ["src/content/main.tsx"],
      run_at: "document_idle",
    },
  ],
  web_accessible_resources: [
    { resources: ["analyzer.worklet.js"], matches: ["https://www.youtube.com/*"] },
  ],
});
