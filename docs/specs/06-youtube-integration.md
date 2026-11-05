# 06 — Integração com o YouTube (`src/content/youtube.ts`, `src/content/main.tsx`)

## Objetivo
Encontrar o player, injetar o botão "Jogar", montar o overlay, traduzir eventos do player para o jogo e isolar o teclado do YouTube durante a partida. **Todo seletor e detalhe do DOM do YouTube vive só em `youtube.ts`.**

## Interface

```ts
export interface YouTubePlayer {
  readonly video: HTMLVideoElement;
  readonly playerEl: HTMLElement;              // #movie_player
  readonly videoId: string | null;
  isAdShowing(): boolean;
  /** Cria (ou reaproveita) o host do overlay dentro do #movie_player. */
  mountOverlayHost(): HTMLElement;
  unmountOverlayHost(): void;
  setGameActive(active: boolean): void;        // classe CSS: esconde o vídeo/controles nativos
  injectPlayButton(onClick: () => void): void;
  on(ev: "ad-start" | "ad-end" | "navigate" | "player-lost", fn: () => void): void;
  dispose(): void;
}

export function findPlayer(): Promise<YouTubePlayer>;   // espera até 10s
export function installKeyboardShield(handler: (e: KeyboardEvent) => void): () => void;
```

## Seletores (únicos pontos de contato com o DOM)

| Uso | Seletor/evento |
| :--- | :--- |
| Player | `#movie_player` |
| Vídeo | `#movie_player video.html5-main-video` |
| Botões à direita | `#movie_player .ytp-right-controls` |
| Anúncio | `#movie_player.ad-showing` (`MutationObserver` em `class`) |
| Legendas | `.ytp-caption-window-container` |
| Navegação SPA | `document` → `yt-navigate-start`, `yt-navigate-finish` |

## Comportamento

### Bootstrap
1. O content script roda em `youtube.com/*`. Em `yt-navigate-finish` (e no carregamento), se o path for `/watch`, chama `findPlayer()` e `injectPlayButton`.
2. Botão: `<button class="ytp-button tabhero-play">` com ícone SVG próprio, inserido como **primeiro** filho de `.ytp-right-controls`. É idempotente (não duplica) e é reinjetado se o YouTube re-renderizar a barra (`MutationObserver`).

### Durante a partida (`setGameActive(true)`)
CSS injetado (via `<style id="tabhero-style">`):
```css
#movie_player.tabhero-active video.html5-main-video { opacity: 0 !important; }
#movie_player.tabhero-active .ytp-chrome-top,
#movie_player.tabhero-active .ytp-chrome-bottom,
#movie_player.tabhero-active .ytp-gradient-top,
#movie_player.tabhero-active .ytp-gradient-bottom,
#movie_player.tabhero-active .ytp-caption-window-container,
#movie_player.tabhero-active .ytp-paid-content-overlay,
#movie_player.tabhero-active .ytp-ce-element { display: none !important; }
```
- O host do overlay é uma `div` com `position:absolute; inset:0; z-index: 70` dentro do `#movie_player`. Assim acompanha o modo cinema e a tela cheia sem lógica extra. Os cliques no overlay não chegam ao player.
- Os controles de anúncio ("Pular anúncio") **devem continuar clicáveis**: durante `AD`, o overlay usa `pointer-events: none` e não esconde `.ytp-ad-*`.

### Escudo de teclado (crítico)
`F` (tela cheia), `J` (−10s), `K` (play/pause), `Espaço`, setas, `0–9` (pular para %), `M`, `,`/`.` e `L` são atalhos do YouTube. Com o jogo ativo:
- `installKeyboardShield` registra `keydown`/`keyup` em `window` na fase de **captura**.
- Para teclas **sem** `ctrl/alt/meta`: `preventDefault()` + `stopImmediatePropagation()` e repasse ao handler do jogo. Teclas com modificador passam (atalhos do navegador).
- Exceção: com o foco em um `input`/`textarea`/`contenteditable` **fora** do player (ex.: caixa de busca), não interceptar.
- `event.repeat` é ignorado pelo jogo.
- Mapeamento: `KeyD/KeyF/KeyJ/KeyK` → pistas 0–3; `Space` → pause/retomar; `Escape` → pause (fora da tela cheia; em tela cheia o navegador sai do fullscreen, e o jogo continua).

### Eventos do `<video>` → jogo
| Evento | Jogo |
| :--- | :--- |
| `pause` (não iniciado pelo jogo) | `pause()` |
| `waiting` | pause automático |
| `playing` após `waiting` | resume automático |
| `seeking` | `seeked()` |
| `ended` | `ended()` |
| `ad-start` / `ad-end` | `adStarted()` / `adEnded()` |
| `navigate` (`yt-navigate-start`) | `exit()` |
| `player-lost` (vídeo trocado/removido) | `exit()` + `ERROR` com mensagem |

Os eventos disparados pelo próprio jogo (ex.: `video.pause()` no pause do jogo) são marcados com uma flag para não gerar loop.

### Autoplay e playlists
Com o jogo ativo, o autoplay do próximo vídeo levaria a `yt-navigate-start` → `exit()`. Comportamento do MVP: a partida termina na tela de resultados (o fim é detectado por `ended` antes da navegação); se o YouTube navegar antes, os resultados são perdidos. **Aceito no MVP.**

## Critérios de aceite
- [ ] Botão aparece em toda página `/watch`, inclusive após navegação SPA, sem duplicar.
- [ ] Durante o jogo, `D F J K`, espaço e setas não disparam ações do YouTube (testar cada uma).
- [ ] Ctrl+R, Ctrl+T etc. continuam funcionando.
- [ ] Digitar na busca do YouTube durante o pause funciona.
- [ ] O overlay acompanha os modos normal, cinema e tela cheia (redimensionamento sem distorção).
- [ ] Anúncio no meio: "Pular anúncio" é clicável.
- [ ] Sair do jogo restaura o vídeo, os controles e as legendas.

## Riscos
- O YouTube muda as classes com frequência. Mitigação: seletores só aqui + um teste manual por release (checklist acima).
- Players embutidos (`youtube.com/embed`) e YouTube Music estão fora do MVP.
