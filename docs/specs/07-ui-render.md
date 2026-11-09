# 07 — UI e renderização (`src/content/game/render.ts`, `src/content/ui/`)

## Objetivo
Desenhar o jogo num Canvas 2D sobre o player e exibir a UI de estado (contagem, pause, sincronizando, anúncio, resultados, erros) com React isolado em Shadow DOM.

## Estrutura do overlay

```
overlay host (div, inset 0, dentro do #movie_player)
└── shadowRoot
    ├── <style> (CSS próprio, sem herdar do YouTube)
    ├── <canvas id="game">          ← render.ts (rAF)
    └── <div id="ui-root">          ← React: HUD + telas por estado
```

- O canvas acompanha o tamanho do host via `ResizeObserver` (em `mountOverlay`); resolução = tamanho CSS × `devicePixelRatio` (limitado a 2). `OverlayHandle.onResize` avisa o loop para redesenhar (redimensionar apaga o canvas).

## Render (Canvas, a cada rAF)

```ts
export function createRenderer(opts?: {
  reducedMotion?: () => boolean;           // prefers-reduced-motion (matchMedia)
  createSurface?: (w, h) => FrameSurface;  // cópia do último frame; padrão: OffscreenCanvas
}): {
  renderFrame(ctx: CanvasRenderingContext2D, s: RenderState): void;
  forgetFrame(): void;                     // DRM: volta ao gradiente
};

interface RenderState {
  now: number;                    // clock.gameTime()
  frame: ImageBitmap | null;      // videoDelay.frameAt(now); null com DRM suspeito
  notes: readonly Note[];         // game.visibleNotes(now - NOTES_BEHIND_S, now + VISIBLE_LEAD_S)
  pressed: readonly boolean[];    // 4 pistas (array reaproveitado)
  feedback: (lane) => {j, at} | null;
  stats: GameStats;
  dim: number;                    // VIDEO_DIM, ou 0,7 em PAUSED/SYNCING
}
```

- O renderer guarda estado (layout, fontes, gradiente, último frame), por isso é criado por `createRenderer`. Layout/fontes/gradiente só mudam com o tamanho do canvas; textos do HUD só quando o valor muda.
- **Último frame:** os bitmaps do `videoDelay` são fechados no seek/flush, então cada frame novo é copiado para uma superfície própria (640×360, barato) e o fundo sempre sai dela. Assim, sem frame, o último continua desenhável mesmo depois de redimensionar.
- `NOTES_BEHIND_S` ≈ 0,25s (em vez de 0,2): o bastante para a cabeça sair pela borda de baixo (a linha fica a 15% da altura do fim; 0,15/0,85 × 1,25s = 0,22s).
- **Escala:** `escala = altura / 720`. Quando a pista é limitada a 40% da largura, as medidas da pista (nota, alvo, fontes de feedback/combo) usam `largura da pista / 4 / 120` para caber.

### Camadas (de baixo para cima)
1. **Fundo:** `frame` em *cover* (mantendo proporção, cortando sobras). Sem frame: último frame desenhado; nunca houve frame (ou DRM): gradiente escuro neutro.
2. **Escurecimento:** retângulo preto com alpha `dim`.
3. **Pista (highway):** centralizada; largura = `min(40% da largura, 4 × 120px × escala)`; fundo preto alpha 0,5; 3 divisórias.
4. **Linha de acerto:** a 85% da altura; 4 alvos (contornos nas cores das pistas); alvo preenchido enquanto a tecla está pressionada.
5. **Notas:** `y(t) = yHit − (t − now) / VISIBLE_LEAD_S × yHit`. A cabeça é um retângulo arredondado (altura 18px × escala). O sustain é uma cauda de 40% da largura da nota, de `y(t)` até `y(sustainUntil)`, limitada ao topo. Notas julgadas como PERFECT/GOOD somem; as com MISS ficam cinza até sair da tela. Com `holding`, o trecho já pontuado da cauda fica mais brilhante.
6. **Feedback:** texto "PERFECT"/"GOOD"/"MISS" sobre o alvo, por 300ms com fade.
7. **HUD do canvas:** score (canto superior esquerdo), combo e multiplicador (acima da linha de acerto, só com combo ≥ 5).

### Cores das pistas (contraste nos dois extremos de vídeo, claro e escuro)
`#22c55e` (D) · `#ef4444` (F) · `#eab308` (J) · `#3b82f6` (K). As letras das teclas aparecem nos alvos.

### Performance
- Nenhuma alocação por frame no loop quente (reusar objetos; `visibleNotes` devolve uma view, não uma cópia).
- Meta: < 4ms por frame (render + captura) a 1080p em máquina média.
- O rAF só roda com o jogo ativo (COUNTDOWN, PLAYING, PAUSED, RESUMING, SYNCING, AD; em AD não desenha, o canvas está escondido). Em RESULTS/ERROR desenha um frame a cada mudança de estado ou resize e para.

## Telas React (por `GameState`)

| Estado | Tela |
| :--- | :--- |
| `COUNTDOWN` | "3", "2", "1", "VAI!" grandes e centralizados; as letras D F J K nos alvos |
| `RESUMING` | "3", "2", "1" grandes e centralizados sobre o último frame (escurecimento normal, `VIDEO_DIM`); Espaço/Esc cancela e volta ao menu de pausa |
| `PAUSED` | "Pausado" + botões **Continuar** (Espaço) e **Sair**; dica: "F, J e K do YouTube estão desativados durante o jogo" |
| `SYNCING` | "Sincronizando…" com barra de `SYNC_AFTER_SEEK_S` (1,5s); um seek durante o SYNCING reinicia a barra (`syncId`) |
| `AD` | Faixa discreta no topo: "Anúncio — o jogo continua depois"; `pointer-events: none` |
| `RESULTS` | Score, precisão `(perfect + 0,5·good) / total`, Perfect/Good/Miss, maior combo; botões **Jogar de novo**, **Próxima música** (só se houver próximo vídeo; ver 06) e **Sair** |
| `ERROR` | Mensagem de `strings.ts` (ex.: `SOURCE_TAKEN`) + **Sair** |
| (qualquer estado, vídeo mudo ou volume 0) | Faixa no topo: "Ative o som do vídeo para jogar" (`role="status"`). Some quando o som volta (`volumechange`). Ver 01, SPIKE 2 |

Botão "Jogar" (fora do overlay; ver 06): tooltip "Jogar TabHero".

## Acessibilidade
- Todos os botões são focáveis por teclado; textos com contraste ≥ 4,5:1 sobre o escurecimento.
- `prefers-reduced-motion`: sem animações de feedback (só a mudança de cor do alvo).

## Critérios de aceite
- [ ] Visual correto nos modos normal, cinema e tela cheia; redimensionar a janela no meio da partida não quebra nada.
- [ ] 60 FPS estáveis com 8 notas/s e sustain ativo (DevTools Performance).
- [ ] Todas as telas da tabela implementadas e alcançáveis.
- [ ] O CSS do YouTube não afeta a UI (Shadow DOM) e vice-versa.

## Checklist de release (M4)
- [ ] Ícones 16/32/48/128 próprios (sem referência a marcas de terceiros).
- [ ] Listagem da Web Store: descrição, 3+ screenshots, política de privacidade ("nenhum dado sai do navegador").
- [ ] Teste manual completo das specs 01–07 numa instalação limpa.
