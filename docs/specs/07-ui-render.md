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

- O canvas acompanha o tamanho do host via `ResizeObserver`; resolução = tamanho CSS × `devicePixelRatio` (limitado a 2).

## Render (Canvas, a cada rAF)

```ts
export function renderFrame(ctx: CanvasRenderingContext2D, s: {
  now: number;                    // clock.gameTime()
  frame: ImageBitmap | null;      // videoDelay.frameAt(now)
  notes: readonly Note[];         // game.visibleNotes(now - 0.2, now + VISIBLE_LEAD_S)
  pressed: readonly boolean[];    // 4 pistas
  feedback: (lane) => {j, at} | null;
  stats: GameStats;
  dim: number;                    // VIDEO_DIM, ou 0,7 em PAUSED/SYNCING
}): void;
```

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
- O rAF só roda com o jogo ativo.

## Telas React (por `GameState`)

| Estado | Tela |
| :--- | :--- |
| `COUNTDOWN` | "3", "2", "1", "VAI!" grandes e centralizados; as letras D F J K nos alvos |
| `PAUSED` | "Pausado" + botões **Continuar** (Espaço) e **Sair**; dica: "F, J e K do YouTube estão desativados durante o jogo" |
| `SYNCING` | "Sincronizando…" com barra de 1,5s |
| `AD` | Faixa discreta no topo: "Anúncio — o jogo continua depois"; `pointer-events: none` |
| `RESULTS` | Score, precisão `(perfect + 0,5·good) / total`, Perfect/Good/Miss, maior combo; botões **Jogar de novo** e **Sair** |
| `ERROR` | Mensagem de `strings.ts` (ex.: `SOURCE_TAKEN`) + **Sair** |

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
