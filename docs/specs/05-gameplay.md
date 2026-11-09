# 05 — Gameplay (`src/content/game/`)

## Objetivo
Máquina de estados da partida, armazenamento das notas, julgamento de input, sustain e pontuação. Não conhece o DOM do YouTube nem desenha nada.

## Interface

```ts
export type GameState =
  | "IDLE" | "COUNTDOWN" | "PLAYING" | "PAUSED" | "RESUMING" | "SYNCING" | "AD" | "RESULTS" | "ERROR";

export type Judgement = "PERFECT" | "GOOD" | "MISS";

export interface Note {
  id: number; t: number; lane: Lane;
  sustainUntil?: number;   // cresce com sustain-extend
  sustainEnd?: number;     // definido em sustain-end
  judged?: Judgement;
  holding?: boolean;
  ticksAwarded: number;
}

export interface GameStats {
  score: number; combo: number; maxCombo: number; multiplier: number;
  perfect: number; good: number; miss: number; ticks: number;
}

export interface Game {
  readonly state: GameState;
  readonly stats: GameStats;
  /** Notas com t em [from, to], ordenadas por t (para o render). */
  visibleNotes(from: number, to: number): readonly Note[];
  lastJudgement(lane: Lane): { j: Judgement; at: number } | null;
  isPressed(lane: Lane): boolean;
  readonly pauseReason: "user" | "buffering" | null;  // buffering = pause automático, sem menu
  readonly countdown: number | null;                  // segundos restantes (só em COUNTDOWN)
  readonly errorCode: string | null;

  // entradas
  onAnalyzerMsg(m: AnalyzerMsg): void;
  onKeyDown(lane: Lane, gameTime: number): void;
  onKeyUp(lane: Lane, gameTime: number): void;
  tick(gameTime: number): void;                   // a cada rAF

  // eventos do player/controle (vêm de main.tsx)
  start(): void;  pause(reason?: "user" | "buffering"): void;  resume(): void;
  seeked(): void; adStarted(): void; adEnded(): void;
  ended(endAt?: number): void;   // procTime do fim da mídia (ctx.currentTime)
  exit(): void;  fail(code: string): void;

  on(ev: "state", fn: (s: GameState) => void): void;
}

export function createGame(effects?: Partial<GameEffects>, cfg?: GameConfig): Game;
```

**Efeitos das transições:** o `Game` continua puro; as ações da tabela abaixo saem por uma interface `GameEffects` (`enterGame`, `startPlayback`, `pause`, `resume`, `flush`, `setAnalysisActive`, `teardown`) injetada em `createGame`. A implementação real fica em `src/content/gameEffects.ts` (`createGameEffects({ graph, video, videoDelay, clock, markOwnMediaEvent, onTeardown })`), criada por `main.tsx`. Assim o jogo é testado com efeitos mock e o adaptador com grafo/vídeo mock.

**Tempo das fases:** `COUNTDOWN` e `SYNCING` contam em `gameTime`, a partir do 1º `tick` no estado.

## Máquina de estados

```
IDLE ──start──► COUNTDOWN ──(COUNTDOWN_S)──► PLAYING ──ended──► RESULTS ──exit/start──► IDLE/COUNTDOWN
                                              │  ▲
                                   pause/     │  │ (RESUME_COUNTDOWN_S) / resume após buffering
                                   waiting    ▼  │
                                             PAUSED ──resume──► RESUMING ──pause──► PAUSED
PLAYING ──seeked──► SYNCING ──(SYNC_AFTER_SEEK_S)──► PLAYING
PLAYING/SYNCING/COUNTDOWN ──adStarted──► AD ──adEnded──► SYNCING
qualquer ──exit──► IDLE        qualquer ──erro──► ERROR ──exit──► IDLE
```

Ações por transição (orquestradas por `main.tsx`, que chama grafo/vídeo/YouTube):

| Transição | Ações |
| :--- | :--- |
| `IDLE → COUNTDOWN` | `graph.setMode("game")`, `video.currentTime = 0`, `video.pause()`, `videoDelay.start()`, zera stats e notas. Em `VIDEO_PLAY_AT_COUNTDOWN_S`: `video.play()` + `clock.resync()` |
| `→ PAUSED` | `video.pause()` + `graph.suspend()`. Com `pause("buffering")`, só `graph.suspend()`: o `<video>` já está parado esperando dados, e pausá-lo impediria o `playing` do resume automático |
| `PAUSED → RESUMING` | Nenhuma: vídeo e grafo seguem parados durante a contagem de `RESUME_COUNTDOWN_S`. Só no pause do usuário; após buffering, o `resume()` vai direto a PLAYING |
| `RESUMING → PLAYING` (fim da contagem) / `PAUSED → PLAYING` (buffering) | `graph.resume()` + `video.play()` + `clock.resync()` |
| `RESUMING → PAUSED` (`pause()` na contagem) | Nenhuma: cancela a contagem; o próximo `resume()` recomeça do zero |
| `→ SYNCING` (seek) | `graph.flush()`, `videoDelay.clear()`, `clock.resync()`, apaga as notas, `combo = 0` |
| `→ AD` | Análise inativa (`graph.setAnalysisActive(false)`), apaga as notas (o fim da música no buffer toca sem jogo, sem MISS), overlay mostra "Anúncio" |
| `AD → SYNCING` | `setAnalysisActive(true)` + as mesmas ações do seek (o buffer tem o anúncio), **mas o combo é mantido** |
| `→ RESULTS` | Após `ended(endAt)`, continua em PLAYING (as últimas notas são jogáveis) até `gameTime ≥ endAt`, o procTime do fim da mídia; sem `endAt`, usa último `gameTime + DELAY_S`. As notas ainda não julgadas viram MISS |
| `→ IDLE` | `graph.dispose()`, `videoDelay.stop()`, restaura o `<video>`, remove overlay |

`seeked` também vale em SYNCING (reinicia a contagem). `adStarted` vale em PLAYING/SYNCING/COUNTDOWN. `pause` só em PLAYING. `fail` vale em qualquer estado (inclusive IDLE, ex.: `SOURCE_TAKEN` no attach).

**Mensagens em trânsito:** depois de cada flush (seek, fim de anúncio), o jogo ignora mensagens do analisador até o `reset-ack` (podem ser de áudio de antes do reset).

**Contagem ao retomar (RESUMING):** a `ctx` está suspensa e o `gameTime` congelado, então a contagem é medida no relógio de parede: `tick(gameTime, wallTime)`, com `wallTime` em segundos (`performance.now()/1000`; padrão: `gameTime`, para os testes). Em RESUMING as teclas não julgam notas, e `countdown` expõe os segundos restantes. `ended` vale em RESUMING como em PAUSED.

`waiting` (buffering do YouTube) é tratado como pause automático (`pause("buffering")`); `playing` subsequente → resume automático (sem menu de pause).

## Notas
- Armazenadas em array ordenado por `t` (as mensagens chegam em ordem).
- `sustain-extend` atualiza `sustainUntil`; `sustain-end` define `sustainEnd` (e `sustainUntil = sustainEnd`).
- Uma nota é removida quando `t` (ou `sustainEnd`/`sustainUntil`) < `gameTime − 1s` e já foi julgada.
- `visibleNotes(from, to)` inclui também as notas com `t < from` cuja cauda alcança `from` (sustain em andamento). Devolve uma view reaproveitada (spec 07: sem alocação por frame).

## Julgamento
- `onKeyDown(lane, gt)`: ignora repetição (`event.repeat` é filtrado antes). Procura a **primeira** nota não julgada da pista com `|t − gt| ≤ WINDOW_MISS_S`.
  - `|Δ| ≤ WINDOW_PERFECT_S` → PERFECT; `≤ WINDOW_GOOD_S` → GOOD; senão → MISS (pressionou cedo/tarde demais).
  - Sem nota na janela: **nenhuma penalidade** (ghost press). Decisão do MVP: charts ao vivo têm imprecisão, e punir o jogador por isso seria injusto.
- `tick(gt)`: toda nota não julgada com `gt − t > WINDOW_MISS_S` → MISS.
- PERFECT/GOOD: `combo++`, `score += base × multiplier`. MISS: `combo = 0`.
- `multiplier = min(1 + floor(combo / COMBO_STEP), MAX_MULTIPLIER)`.

## Sustain
- A cabeça é julgada como uma nota normal; com PERFECT/GOOD, `holding = true`.
- Em `tick`, enquanto `holding` e a tecla da pista estiver pressionada: para cada `SUSTAIN_TICK_S` decorrido entre `t` e `min(gt, sustainUntil)`, `ticksAwarded++` e `score += SCORE_TICK × multiplier`.
- `onKeyUp` antes de `(sustainEnd ?? sustainUntil) − SUSTAIN_RELEASE_TOLERANCE_S` → `holding = false`; os ticks param; **o combo não quebra**.
- Uma cabeça julgada como MISS não dá ticks.
- Soltar a partir de `sustainEnd − SUSTAIN_RELEASE_TOLERANCE_S` conta como sustain completo (ganha os ticks até o fim). Soltar cedo não retoma: apertar de novo não volta a dar ticks.
- Sem `sustainEnd` ainda, o `holding` continua depois de `sustainUntil` (o sustain pode crescer).
- No pause, as teclas e o `holding` são zerados (keyups se perdem com blur/menu).
- As janelas têm folga de 1µs para ponto flutuante (`t ± 45ms` exatos é PERFECT).

## Critérios de aceite
- [x] Todas as transições da tabela cobertas por testes unitários com mocks (`tests/game.test.ts`, `tests/gameEffects.test.ts`).
- [x] Input a exatamente `t ± 45ms` → PERFECT; `± 46ms` → GOOD; `± 136ms` → sem julgamento (e depois MISS pelo `tick`).
- [x] Duas notas na mesma pista separadas por 100ms: dois toques corretos julgam cada uma (o primeiro não "consome" a segunda).
- [x] Sustain de 1s segurado inteiro: `ticksAwarded = 10` (± 1).
- [x] Seek durante PLAYING → SYNCING → PLAYING; o combo zera e o score se mantém.
- [x] Anúncio no meio → AD → SYNCING → PLAYING sem notas do anúncio.
- [x] Fim do vídeo → RESULTS só depois de o último áudio atrasado tocar (com `endAt` = procTime do fim). Ligado em `main.tsx` (spec 06: `ended` → `ended(ctx.currentTime)`); **pendente:** conferir no YouTube.

## Testes
Vitest com relógio manual, sem DOM: sequências de `onAnalyzerMsg`/`onKeyDown`/`tick` com resultados esperados.
