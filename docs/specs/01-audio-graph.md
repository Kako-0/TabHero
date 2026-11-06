# 01 — Grafo de áudio (`src/content/audioGraph.ts`)

## Objetivo
Capturar o áudio do `<video>` do YouTube, entregar uma cópia **sem atraso** ao analisador (worklet) e tocar para o usuário uma cópia **atrasada em `DELAY_S`**, com controle de pause, flush e restauração do som normal.

## Fora de escopo
Análise (04), relógio (02), vídeo (03), captura via `tabCapture`.

## Interface

```ts
export type GraphMode = "passthrough" | "game";

export interface AudioGraph {
  readonly ctx: AudioContext;
  readonly mode: GraphMode;
  readonly analyzerPort: MessagePort;           // AnalyzerMsg ← / AnalyzerCmd →

  /** Deve ser chamado dentro do handler do clique em "Jogar" (política de autoplay). */
  static attach(video: HTMLVideoElement): Promise<AudioGraph>;

  setMode(mode: GraphMode): void;
  /** Recria o DelayNode (descarta o áudio no buffer) e envia `reset` ao analisador. */
  flush(): void;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  /** Latência de saída estimada (s), atualizada a cada OUTPUT_LATENCY_POLL_MS. */
  getOutputLatency(): number;
  dispose(): void;   // volta a passthrough; NÃO destrói a MediaElementSource
}

export class AudioGraphError extends Error {
  code: "SOURCE_TAKEN" | "WORKLET_LOAD_FAILED" | "CONTEXT_FAILED";
}
```

**Implementação:** `AudioGraph` é uma classe (`extends EventTarget`) com construtor privado; `"context-interrupted"` é exportado como `CONTEXT_INTERRUPTED`. As mensagens de erro de cada `code` estão em `STRINGS.errors`.

## Comportamento

### Topologia
```
mode = "passthrough":   source ──► destination

mode = "game":          source ──┬──► analyzerNode (AudioWorkletNode, numberOfOutputs: 0)
                                 └──► delayNode (maxDelayTime 2s, delayTime = DELAY_S) ──► masterGain ──► destination
```

### Ciclo de vida
1. `attach(video)`:
   - Reutiliza um `AudioContext` e uma `MediaElementAudioSourceNode` guardados em `WeakMap<HTMLVideoElement, {ctx, source}>` no escopo do content script. Uma source por elemento, **para sempre**.
   - Se não existir: `new AudioContext({ latencyHint: "interactive" })` e `ctx.createMediaElementSource(video)`.
   - `InvalidStateError` → `AudioGraphError("SOURCE_TAKEN")`.
   - Carrega o worklet (ver SPIKE 1); se falhar → `WORKLET_LOAD_FAILED`.
   - Se `ctx.state !== "running"`, chama `await ctx.resume()`.
   - Termina em `passthrough`.
2. `setMode("game")`: desconecta `source → destination` e conecta a topologia de jogo; envia `set-active: true` ao analisador.
3. `setMode("passthrough")`: o inverso; envia `set-active: false`.
4. `flush()`: `delayNode.disconnect()`, cria um `DelayNode` novo, reconecta e envia `{type:"reset", at: ctx.currentTime}`.
5. `suspend()/resume()`: delegam a `ctx.suspend()/resume()`. O buffer do `DelayNode` é preservado (é o comportamento desejado no pause).
6. `dispose()`: `setMode("passthrough")` e para o polling de latência. A `ctx` continua viva enquanto a página existir.

### Latência de saída
- Fonte primária: `ctx.outputLatency` (Chrome ≥ 102); somar `ctx.baseLatency`.
- Re-amostrada a cada `OUTPUT_LATENCY_POLL_MS`; a mudança é aplicada gradualmente (no máximo 5ms por segundo) para não fazer as notas "pularem".
- **Não** compensar duas vezes: o relógio (02) define qual fonte de latência é usada (ver SPIKE 3).

### `statechange`
Se a `ctx` sair de `running` sem o jogo ter pedido (`interrupted`, ou suspensa pelo sistema), emitir o evento `"context-interrupted"`; o jogo trata como pause (05).

### Notas de implementação
- O `AudioWorkletNode` também fica na `WeakMap` e é reaproveitado entre `attach`s (o `process()` devolve `true`, então criar um por `attach` deixaria processors órfãos). Em consequência, `analyzerPort` é o mesmo entre `attach`s do mesmo vídeo.
- Logo após criar a source, ela é ligada em `source → destination`: se o worklet falhar (`WORKLET_LOAD_FAILED`), o vídeo continua com som e o próximo `attach` tenta carregar o worklet de novo.
- `SOURCE_TAKEN` fecha a `AudioContext` recém-criada.
- `flush()` também desliga `source → delay antigo` (só `delayNode.disconnect()` deixaria o nó antigo recebendo áudio). Em `passthrough`, o delay novo é criado mas não ligado.
- `setMode` só liga e desliga arestas; os nós (`delay`, `masterGain`) são criados uma vez por `AudioGraph`.
- A rampa de latência é o `LatencySmoother` (primeira medida aplicada direto; depois, no máximo 5ms/s nos dois sentidos).
- Build de dev (`VITE_DEBUG=true`): o clique em "Jogar" já põe o grafo em `game`, para o teste manual de atraso do M0.

## Erros e casos de borda
| Caso | Comportamento |
| :--- | :--- |
| Outra extensão já criou a source | `SOURCE_TAKEN` → UI mostra "Outra extensão de áudio está usando este vídeo. Desative-a e recarregue a página." |
| Extensão atualizada/recarregada com a página aberta (content script órfão segurando a source) | Mesmo erro `SOURCE_TAKEN`; mensagem pede para recarregar a página |
| `<video>` substituído pelo YouTube (raro) | `youtube.ts` detecta e o jogo sai para `passthrough`; o próximo "Jogar" faz `attach` do novo elemento |
| `video.muted` ou volume 0 | Ver SPIKE 2 |
| Mídia cross-origin sem CORS | Fora do escopo (o YouTube usa MSE/blob) |

## Critérios de aceite
- [x] Em `passthrough`, o som do vídeo é indistinguível do normal (volume, sem atraso perceptível).
- [x] Em `game`, o som sai `DELAY_S` ± 20ms depois da imagem original (medido com vídeo de clap/flash).
- [x] `flush()` elimina o áudio antigo: nenhum som do trecho anterior ao seek é ouvido.
- [x] `suspend()` + `resume()` retoma o áudio atrasado sem salto audível (< 30ms de descontinuidade).
- [x] Alternar `game ↔ passthrough` 20 vezes não vaza nós (verificar no `chrome://media-internals` / heap).
- [x] `SOURCE_TAKEN` reproduzido com uma segunda instância (simular criando a source antes) → mensagem correta.

## Testes
- **Unitário (Vitest + mock de Web Audio):** transições de modo, `flush` envia `reset`, dupla `attach` reutiliza a source.
- **Manual (M0):** página de teste com vídeo de clap; medir o atraso gravando a tela com o áudio do sistema.

## Riscos / SPIKE
1. **SPIKE: carregar o worklet a partir do content script.** Tentar, em ordem:
   1. `ctx.audioWorklet.addModule(chrome.runtime.getURL("analyzer.worklet.js"))` com a entrada em `web_accessible_resources`;
   2. `fetch` do arquivo → `Blob` → `URL.createObjectURL` → `addModule`;
   3. fallback: `AnalyserNode` + análise no main thread a cada `rAF` (degrada a precisão; registrar a decisão aqui).

   Verificar também se o Meyda e o `pitchy` executam em `AudioWorkletGlobalScope` (sem `window`).

   **Resposta parcial (setup, spec 09):** a opção 1 funciona. Com o worklet no-op, `addModule(chrome.runtime.getURL(...))` + `new AudioWorkletNode(ctx, "tabhero-analyzer")` carregam sem erro num `/watch` (log `[TabHero] worklet ok`). As opções 2 e 3 não são necessárias. **Pendente:** Meyda e `pitchy` dentro do worklet (no M0/M1, quando entrarem no bundle).
2. **SPIKE: `video.volume`/`muted` afetam a saída da `MediaElementSource`?** Se afetam, a análise sofre com volume baixo, e não há como capturar o sinal antes do volume. Mitigação: normalizar o sinal no analisador (ganho automático por RMS móvel) e, com `muted`/volume 0, mostrar o aviso "Ative o som do vídeo para jogar".

   **Resposta (M0):** **afetam.** O volume do player do YouTube (`video.volume`) e o mudo (`video.muted`) são aplicados antes da `MediaElementSource`. Testado no `/watch` em modo `game`: baixar o volume baixa o som atrasado, e o mudo o silencia. A mitigação foi implementada:
   - `src/analysis/autoGain.ts`: ganho automático na entrada do `StreamAnalyzer` (spec 04, etapa 0).
   - `src/content/soundCheck.ts` + `App`: com `muted` ou `volume === 0`, o overlay mostra `STRINGS.soundOffWarning` ("Ative o som do vídeo para jogar") e atualiza em `volumechange`.
3. **SPIKE: `outputLatency` vs `getOutputTimestamp()`.** Ver 02.
