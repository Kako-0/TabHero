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
  hasNext(): boolean;                          // há próximo vídeo (playlist, mix, autoplay)
  goNext(): boolean;                           // clica no "próximo" do YouTube; false se não houver
  /** Cria (ou reaproveita) o host do overlay dentro do #movie_player. */
  mountOverlayHost(): HTMLElement;
  unmountOverlayHost(): void;
  setGameActive(active: boolean): void;        // classe CSS: esconde o vídeo/controles nativos
  injectPlayButton(onClick: () => void): void;
  /** Devolve a função de cancelamento. */
  on(ev: "ad-start" | "ad-end" | "navigate" | "player-lost", fn: () => void): () => void;
  dispose(): void;                             // também remove o botão (o clique aponta para este player)
}

export function findPlayer(): Promise<YouTubePlayer>;   // espera até 10s
/** `target`/`getPlayerEl` são injetáveis para os testes (padrão: window e #movie_player). */
export function installKeyboardShield(handler: (e: KeyboardEvent) => void, target?, getPlayerEl?): () => void;
export function shouldShield(e: KeyboardEvent, playerEl): boolean;   // a regra do escudo, pura
```

## Seletores (únicos pontos de contato com o DOM)

| Uso | Seletor/evento |
| :--- | :--- |
| Player | `#movie_player` |
| Próximo vídeo | `#movie_player .ytp-next-button` (escondido com `display:none` inline quando não há próximo) |
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
- O host do overlay é uma `div` com `position:absolute; inset:0; z-index: 70` dentro do `#movie_player`. Assim acompanha o modo cinema e a tela cheia sem lógica extra. Os cliques no overlay não chegam ao player: o host chama `stopPropagation()` em `click`, `dblclick`, `mousedown/up`, `pointerdown/up` e `contextmenu`.
- Os controles de anúncio ("Pular anúncio") **devem continuar clicáveis**: durante `AD`, o overlay usa `pointer-events: none` e não esconde `.ytp-ad-*`. Para o botão também ficar **visível**, com `ad-showing` o `<video>` volta a `opacity: 1` (o anúncio aparece ao vivo) e o canvas do jogo fica oculto; só a faixa "Anúncio" é desenhada. O áudio do anúncio continua atrasado em `DELAY_S` (aceito no MVP).
```css
#movie_player.tabhero-active.ad-showing video.html5-main-video { opacity: 1 !important; }
#movie_player.ad-showing > #tabhero-overlay-host { pointer-events: none !important; }
```
- Anúncio no momento do clique em "Jogar": o grafo é ligado, mas a partida (`start()`) só começa no `ad-end`.

### Escudo de teclado (crítico)
`F` (tela cheia), `J` (−10s), `K` (play/pause), `Espaço`, setas, `0–9` (pular para %), `M`, `,`/`.` e `L` são atalhos do YouTube. Com o jogo ativo:
- `installKeyboardShield` registra `keydown`/`keyup` em `window` na fase de **captura**.
- Para teclas **sem** `ctrl/alt/meta`: `preventDefault()` + `stopImmediatePropagation()` e repasse ao handler do jogo. Teclas com modificador passam (atalhos do navegador). `Shift` não conta como modificador (`Shift+N` é atalho do YouTube).
- Exceção: com o foco em um `input`/`textarea`/`select`/`contenteditable` **fora** do player (ex.: caixa de busca), não interceptar. O alvo é `composedPath()[0]` (o real, mesmo dentro de Shadow DOM).
- Exceção: `Tab` (navegação por foco nos botões do overlay) e `F1`–`F12` (F5, F11, F12) nunca são interceptadas.
- `event.repeat` é ignorado pelo jogo.
- Mapeamento: `KeyD/KeyF/KeyJ/KeyK` → pistas 0–3; `Space` → pause/retomar (retomar passa pela contagem `RESUMING`; Espaço na contagem volta ao pause); `Escape` → pause (fora da tela cheia; em tela cheia o navegador sai do fullscreen, e o jogo continua).

### Eventos do `<video>` → jogo
| Evento | Jogo |
| :--- | :--- |
| `pause` (não iniciado pelo jogo, e com `!video.ended`) | `pause("user")` |
| `waiting` (em PLAYING) | `pause("buffering")` (só suspende o grafo; ver 05) |
| `playing` em PAUSED por buffering | `resume()` |
| `seeking` | `seeked()` |
| `ended` | `ended(ctx.currentTime)` |
| `ad-start` / `ad-end` | `adStarted()` / `adEnded()` |
| `navigate` (`yt-navigate-start`) | `exit()` |
| `player-lost` (vídeo trocado/removido) | `exit()` + overlay de erro (`PLAYER_LOST`) com **Sair**, se o `#movie_player` ainda existir |

- `player-lost` é verificado a cada mutação no `#movie_player` e a cada 1s (o player pode sair do DOM sem mutação nele): `#movie_player` ou o `<video>` desconectados, ou `SEL.video` apontando para outro elemento.
- Os eventos disparados pelo próprio jogo (ex.: `video.pause()` no pause do jogo) são marcados com uma flag para não gerar loop: `markOwnMediaEvent(kind)` só marca se o evento vai mesmo acontecer (`pause` com o vídeo tocando), e o handler de `pause` consome a flag.
- No fim da mídia, o `<video>` dispara `pause` antes de `ended`; por isso `pause` com `video.ended` é ignorado (senão o jogo iria para PAUSED e o RESULTS nunca chegaria).

### Autoplay e playlists: o jogo segura o fim
O autoplay (ou o próximo item de um mix/playlist) navega no `ended`, o que levaria a `exit()` e perderia a partida. O jogo **não mexe na configuração de autoplay do YouTube** (é uma preferência salva do usuário, e mix/playlist não têm como desligar). Em vez disso:
- **Segurar o fim:** a cada rAF e a cada `timeupdate`, em PLAYING/SYNCING e fora de anúncio, se faltar ≤ `HOLD_END_S` (0,3s) para o fim, o jogo pausa o `<video>` (evento marcado como próprio) e chama `ended(ctx.currentTime)`. Sem `ended`, o YouTube não avança; o áudio atrasado toca até o fim e o RESULTS fica na tela. O `timeupdate` (~250ms) cobre a aba em segundo plano, onde o rAF para. Lives (`duration = Infinity`) nunca são seguradas. Os ~0,3s finais não são tocados (costumam ser silêncio/fade).
- **Resultados:**
  - **Jogar de novo:** como antes (volta ao início do vídeo).
  - **Próxima música** (só se houver próximo: botão `.ytp-next-button` visível): `exit()`, clica no "próximo" do YouTube (playlist, mix ou sugestão do autoplay) e, quando o vídeo novo estiver tocando (`playing`; ou após 5s), começa a partida sozinho. Com anúncio no vídeo novo, a partida espera o fim dele.
  - **Sair:** `exit()` e solta o fim segurado (`video.play()`): o vídeo termina e o YouTube segue o autoplay/playlist conforme a configuração do usuário.
- Se o fim escapar (ex.: aba em segundo plano com `timeupdate` atrasado) e o YouTube navegar, vale `navigate` → `exit()`: os resultados se perdem. Aceito.

## Critérios de aceite
- [x] Botão aparece em toda página `/watch`, inclusive após navegação SPA, sem duplicar.
- [x] Durante o jogo, `D F J K`, espaço e setas não disparam ações do YouTube (testar cada uma).
- [x] Ctrl+R, Ctrl+T etc. continuam funcionando.
- [x] Digitar na busca do YouTube durante o pause funciona.
- [x] O overlay acompanha os modos normal, cinema e tela cheia (redimensionamento sem distorção).
- [x] Anúncio no meio: "Pular anúncio" é clicável.
- [x] Sair do jogo restaura o vídeo, os controles e as legendas.

## Testes
- Automatizado (`tests/youtube.test.ts`): regra do escudo (`shouldShield`) para cada atalho do YouTube, modificadores, `Tab`/`F*` e campos editáveis dentro/fora do player; `installKeyboardShield` com `EventTarget` (captura, `preventDefault`, `stopImmediatePropagation`, remoção). `tests/gameEffects.test.ts`: `markOwnMediaEvent(kind)` e pause por buffering.
- Manual: checklist dos critérios de aceite acima, no YouTube.

## Riscos
- O YouTube muda as classes com frequência. Mitigação: seletores só aqui + um teste manual por release (checklist acima).
- Ordem dos eventos no anúncio: o YouTube usa o mesmo `<video>` para o anúncio; se `pause`/`seeking`/`ended` chegarem antes da classe `ad-showing`, o jogo vai para PAUSED/SYNCING em vez de AD. Conferir no teste manual.
- Escudo em `window`/captura: um listener de captura em `window` registrado pelo YouTube **antes** do content script ainda roda. Conferir cada atalho no teste manual.
- Players embutidos (`youtube.com/embed`) e YouTube Music estão fora do MVP.
