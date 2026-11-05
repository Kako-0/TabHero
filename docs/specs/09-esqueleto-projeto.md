# 09 — Esqueleto do projeto (setup)

> **Implementar primeiro.** As specs 01–08 assumem esta estrutura, scripts e ferramentas.

## Objetivo
Criar a base do repositório: build da extensão (MV3) com Vite + crxjs, React + TypeScript, build separado do AudioWorklet, testes, suíte de qualidade vazia, lint e CI. Ao final, a extensão carrega no Chrome, injeta um botão placeholder no YouTube e carrega um worklet no-op. Isso já é o primeiro passo do SPIKE 1 da spec 01.

## Fora de escopo
Qualquer lógica de jogo, áudio ou análise além de stubs.

## Ferramentas e versões
Versões mais recentes estáveis em **2026-11-05** (conferidas no registro do npm e em nodejs.org). Elas ficam travadas no `yarn.lock`; as faixas abaixo são as do `package.json`.

| Ferramenta | Versão | Uso |
| :--- | :--- | :--- |
| Node.js | **26.13.0** (`.nvmrc`: `26`); é a versão mais recente e LTS "Lithium" | Build, testes, suíte de qualidade |
| Yarn | **1.22.22** (Classic; `"packageManager": "yarn@1.22.22"`) | Gerenciador de pacotes (`yarn.lock` commitado) |
| TypeScript | **^6.0.3**, `strict` | Ver nota abaixo sobre o TS 7 |
| Vite | ^8.3.6 | Bundler (Rolldown) |
| `@crxjs/vite-plugin` | ^3.0.0 | Manifest, content scripts com HMR, empacotamento MV3 |
| `@vitejs/plugin-react` | ^6.2.1 | JSX/Fast Refresh (exige Vite 8) |
| React / React DOM | ^19.3.1 | UI do overlay |
| `@types/react` / `@types/react-dom` | ^19.3.0 | — |
| `@types/chrome` | ^0.3.7 | Tipos das APIs de extensão |
| `@types/node` | ^26.6.6 | Tipos de Node para configs do Vite, `quality/` e testes (adicionado no setup) |
| Vitest | ^5.1.0 | Testes unitários |
| `standardized-audio-context-mock` | ^10.0.1 | Mock de Web Audio nos testes (MIT) |
| `tsx` | ^4.23.15 | Executar `quality/run.ts` |
| `wavefile` | ^11.0.0 | Ler WAV na suíte de qualidade (MIT) |
| ESLint + `@eslint/js` | ^10.14.0 / ^10.0.1 | Lint (flat config) |
| `typescript-eslint` | ^8.72.1 | Regras/parser TS |
| `eslint-plugin-react-hooks` + `globals` | ^7.1.1 / ^17.14.0 | — |
| Prettier | ^3.9.10 | Formatação |
| `concurrently` | ^10.0.6 | Rodar o watch do worklet e o Vite juntos, em qualquer SO |
| `license-checker-rseidelsohn` | ^5.0.1 | Garante só licenças permitidas (00 › Convenções) |

**Dependências de runtime:** `react` ^19.3.1, `react-dom` ^19.3.1, `meyda` ^5.6.3, `pitchy` ^4.1.0, `fft.js` ^4.0.4. Nada além disso sem atualizar a spec 00.

> **TypeScript 7:** o 7.0.2 (compilador nativo) é a versão mais recente, mas o `typescript-eslint` 8.72.1 só aceita `typescript >=4.8.4 <6.1.0`. Por isso o projeto fixa o **6.0.3**. Migrar para o 7 quando o `typescript-eslint` suportar.

### Yarn
- **Yarn Classic 1.22.22**, com `node_modules` tradicional (sem PnP, sem `.yarnrc.yml`, sem pasta `.yarn/`).
- Instalação: `corepack enable` (o Corepack respeita `"packageManager": "yarn@1.22.22"`) ou `npm i -g yarn@1.22.22`.
- Commitar `yarn.lock`. Não misturar com `npm install` (não gerar `package-lock.json`).
- O Yarn 1 está em modo de manutenção. Se algum pacote exigir um recurso só do Yarn 2+ (ex.: o protocolo `workspace:`), registrar aqui antes de contornar.

## Estrutura de diretórios

```
tabhero/
├── .github/workflows/ci.yml
├── .nvmrc                          # 26
├── .gitignore                      # node_modules, dist, *.zip, package-lock.json,
│                                   # public/analyzer.worklet.js, quality/report.md,
│                                   # quality/dataset/**/audio.wav (quando não redistribuível)
├── package.json
├── yarn.lock
├── tsconfig.json                   # base (strict, paths)
├── tsconfig.worklet.json           # lib: ["ES2022"], types do AudioWorkletGlobalScope, sem DOM
├── vite.config.ts                  # build da extensão (crxjs + react)
├── vite.worklet.config.ts          # build do worklet (IIFE único)
├── vitest.config.ts
├── eslint.config.js
├── manifest.config.ts              # defineManifest (crxjs)
├── public/
│   └── icons/                      # icon-16/32/48/128.png (placeholders no setup)
├── src/
│   ├── shared/
│   │   ├── config.ts               # CONFIG (spec 00)
│   │   ├── types.ts                # Lane, AnalyzerMsg, AnalyzerCmd (spec 00)
│   │   ├── strings.ts              # textos pt-BR
│   │   └── log.ts                  # log com prefixo [TabHero], só se DEBUG
│   ├── background.ts               # stub
│   ├── content/
│   │   ├── main.tsx                # bootstrap: encontra player, injeta botão placeholder
│   │   ├── youtube.ts              # stub com findPlayer()
│   │   ├── audioGraph.ts           # stub: cria ctx + addModule do worklet no-op
│   │   ├── clock.ts                # stub
│   │   ├── videoDelay.ts           # stub
│   │   ├── game/
│   │   │   ├── game.ts             # stub
│   │   │   └── render.ts           # stub
│   │   └── ui/
│   │       ├── mountOverlay.tsx    # Shadow DOM + React root
│   │       └── App.tsx             # placeholder "TabHero"
│   ├── analysis/
│   │   └── streamAnalyzer.ts       # stub: push() → []
│   └── worklet/
│       ├── analyzer.worklet.ts     # registerProcessor("tabhero-analyzer") no-op
│       └── worklet-globals.d.ts
├── tests/
│   ├── setup.ts                    # mocks globais (Web Audio)
│   └── smoke.test.ts               # importa config/types/streamAnalyzer
├── quality/
│   ├── dataset/.gitkeep
│   ├── run.ts                      # sem faixas → imprime "dataset vazio" e sai 0
│   └── baseline.json               # {}
└── docs/specs/                     # estas specs
```

Os nomes de arquivo das specs 01–08 seguem esta árvore. Arquivos novos entram no mesmo diretório do módulo.

## `package.json`

```json
{
  "name": "tabhero",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "license": "MIT",
  "packageManager": "yarn@1.22.22",
  "engines": { "node": ">=26.13.0" },
  "scripts": {
    "dev": "concurrently -k -n worklet,vite \"yarn build:worklet --watch\" \"vite\"",
    "build": "yarn build:worklet && yarn typecheck && vite build",
    "build:worklet": "vite build --config vite.worklet.config.ts",
    "zip": "yarn build && node -e \"const v=require('./package.json').version;require('child_process').execSync('cd dist && zip -r ../tabhero-'+v+'.zip .',{stdio:'inherit'})\"",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.worklet.json",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "quality": "tsx quality/run.ts",
    "licenses:check": "license-checker-rseidelsohn --production --excludePrivatePackages --onlyAllow 'MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD'"
  }
}
```

Os argumentos são repassados direto, sem `--`: `yarn quality --update-baseline`.

> **Nota do setup:** o script de licenças se chama `licenses:check` porque `yarn licenses` é um comando nativo do Yarn 1 e tem precedência sobre scripts. `--excludePrivatePackages` exclui o próprio `tabhero` (privado, reportado como `UNLICENSED`).

## Manifest (`manifest.config.ts`)

```ts
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "TabHero",
  version: pkg.version,
  description: "Jogo de ritmo gerado ao vivo a partir do áudio de vídeos do YouTube.",
  icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
  permissions: ["storage"],
  host_permissions: ["https://www.youtube.com/*"],
  background: { service_worker: "src/background.ts", type: "module" },
  content_scripts: [{ matches: ["https://www.youtube.com/*"], js: ["src/content/main.tsx"], run_at: "document_idle" }],
  web_accessible_resources: [{ resources: ["analyzer.worklet.js"], matches: ["https://www.youtube.com/*"] }],
});
```

## Build do worklet (`vite.worklet.config.ts`)
O AudioWorklet precisa ser **um único arquivo autocontido**, sem imports dinâmicos nem chunks, carregado por URL. Por isso tem um build separado do crxjs:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "public",                    // copiado para dist/ pelo build principal
    emptyOutDir: false,
    lib: {
      entry: "src/worklet/analyzer.worklet.ts",
      formats: ["iife"],
      name: "TabHeroAnalyzer",
      fileName: () => "analyzer.worklet.js",
    },
    target: "es2022",
    minify: true,
  },
});
```

- `public/analyzer.worklet.js` é artefato de build e fica no `.gitignore`.
- Carregamento (stub em `audioGraph.ts`): `ctx.audioWorklet.addModule(chrome.runtime.getURL("analyzer.worklet.js"))`.
- O worklet importa `src/analysis/*` e `src/shared/*`. Esses módulos **não podem** referenciar `window`, `document` nem tipos DOM; o `tsconfig.worklet.json` garante isso no typecheck.
- **Vite 8 usa Rolldown:** opções avançadas vão em `build.rolldownOptions` (não `rollupOptions`). **Verificado no setup:** o modo `lib` + `iife` gera um único `analyzer.worklet.js` sem `import`, com `src/analysis` e `src/shared` embutidos.

## TypeScript
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `moduleResolution: "bundler"`, `jsx: "react-jsx"`, `types: ["chrome", "vite/client", "node"]`, `allowImportingTsExtensions` (para `import "./manifest.config.ts"` no `vite.config.ts`, exigido pelo config loader nativo do Vite 8), alias `@/*` → `src/*`. Exclui `src/worklet`.
- `tsconfig.worklet.json`: `include: ["src/worklet", "src/analysis", "src/shared"]`, `lib: ["ES2022"]`, sem `"DOM"`. Tipos do `AudioWorkletGlobalScope` (`registerProcessor`, `AudioWorkletProcessor`, `currentFrame`, `sampleRate`) declarados em `src/worklet/worklet-globals.d.ts`. Os tipos de `import.meta.env` ficam em `src/shared/env.d.ts` (sem `vite/client`, que puxa DOM), para `log.ts` funcionar nos dois tsconfigs.

## Testes (`vitest.config.ts`)
- `environment: "node"` por padrão (analysis, game e clock usam mocks).
- `tests/setup.ts` instala o `standardized-audio-context-mock` como `globalThis.AudioContext` só nos arquivos que precisam (`// @vitest-environment` + import explícito).
- Os testes ficam ao lado dos módulos (`*.test.ts`) ou em `tests/` para os de integração.

## Debug
- `import.meta.env.VITE_DEBUG === "true"` habilita `log.ts` e um painel de debug no overlay (fps, `gameTime`, latência, frames no buffer, notas/s). O painel nasce como stub e é preenchido no M0.
- `.env.development`: `VITE_DEBUG=true`; o build de produção não usa `.env`.

## CI (`.github/workflows/ci.yml`)
Em todo push/PR: `actions/setup-node` com `node-version-file: .nvmrc`, `corepack enable`, `yarn install --frozen-lockfile`, e então:
1. `yarn lint`
2. `yarn typecheck`
3. `yarn test`
4. `yarn licenses:check`
5. `yarn quality` (com dataset vazio, passa; a partir do M1, compara com a baseline)
6. `yarn build` e upload de `dist/` como artefato

## Fluxo de desenvolvimento
1. `nvm install && nvm use` (Node 26) e `corepack enable` (ou `npm i -g yarn@1.22.22`)
2. `yarn install`
3. `yarn dev`
4. Em `chrome://extensions`: ativar o modo desenvolvedor → **Carregar sem compactação** → selecionar `dist/`.
5. Abrir um vídeo em `youtube.com/watch`. O HMR do crxjs recarrega o content script. Mudanças no worklet exigem recarregar a aba.

## Critérios de aceite
- [ ] `corepack enable && yarn install && yarn build` gera `dist/` com `manifest.json`, `analyzer.worklet.js` e os ícones.
- [ ] `yarn install --frozen-lockfile` passa num clone limpo (lockfile consistente).
- [ ] `yarn --version` no projeto retorna `1.22.22`.
- [ ] A extensão carregada sem compactação, num `/watch`, mostra o botão placeholder na barra do player, inclusive após navegação SPA entre vídeos.
- [ ] Clicar no botão cria o `AudioContext` e **carrega o worklet no-op sem erro** (log `[TabHero] worklet ok`). Se falhar, registrar o erro no SPIKE 1 da spec 01.
- [ ] Clicar no botão monta o overlay (Shadow DOM) com o texto "TabHero" sobre o player; um segundo clique remove.
- [ ] `yarn typecheck` falha se `src/analysis/` usar `window` (verificar com um teste negativo manual).
- [ ] `yarn test`, `yarn lint`, `yarn licenses:check` e `yarn quality` passam.
- [ ] CI verde no primeiro PR.
