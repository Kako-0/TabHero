# 05 — Gameplay (`src/content/game/`)

## Objetivo
Máquina de estados da partida, armazenamento das notas, julgamento de input, sustain e pontuação. Não conhece o DOM do YouTube nem desenha nada.

## Interface

```ts
export type GameState =
  | "IDLE" | "COUNTDOWN" | "PLAYING" | "PAUSED" | "SYNCING" | "AD" | "RESULTS" | "ERROR";

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

  // entradas
  onAnalyzerMsg(m: AnalyzerMsg): void;
  onKeyDown(lane: Lane, gameTime: number): void;
  onKeyUp(lane: Lane, gameTime: number): void;
  tick(gameTime: number): void;                   // a cada rAF

  // eventos do player/controle (vêm de main.tsx)
  start(): void;  pause(): void;  resume(): void;
  seeked(): void; adStarted(): void; adEnded(): void; ended(): void;
  exit(): void;

  on(ev: "state", fn: (s: GameState) => void): void;
}
```

## Máquina de estados

```
IDLE ──start──► COUNTDOWN ──(COUNTDOWN_S)──► PLAYING ──ended──► RESULTS ──exit/start──► IDLE/COUNTDOWN
                                              │  ▲
                                   pause/     │  │ resume
                                   waiting    ▼  │
                                             PAUSED
PLAYING ──seeked──► SYNCING ──(SYNC_AFTER_SEEK_S)──► PLAYING
PLAYING/SYNCING/COUNTDOWN ──adStarted──► AD ──adEnded──► SYNCING
qualquer ──exit──► IDLE        qualquer ──erro──► ERROR ──exit──► IDLE
```

Ações por transição (orquestradas por `main.tsx`, que chama grafo/vídeo/YouTube):

| Transição | Ações |
| :--- | :--- |
| `IDLE → COUNTDOWN` | `graph.setMode("game")`, `video.currentTime = 0`, `video.pause()`, `videoDelay.start()`, zera stats e notas. Em `VIDEO_PLAY_AT_COUNTDOWN_S`: `video.play()` + `clock.resync()` |
| `→ PAUSED` | `video.pause()` + `graph.suspend()` |
| `PAUSED → PLAYING` | `graph.resume()` + `video.play()` + `clock.resync()` |
| `→ SYNCING` (seek) | `graph.flush()`, `videoDelay.clear()`, apaga as notas, `combo = 0` |
| `→ AD` | Análise inativa (`set-active:false`), overlay mostra "Anúncio" |
| `→ RESULTS` | Espera `DELAY_S` após `ended` (o final do áudio ainda está no buffer) e depois mostra os resultados |
| `→ IDLE` | `graph.dispose()`, `videoDelay.stop()`, restaura o `<video>`, remove overlay |

`waiting` (buffering do YouTube) é tratado como pause automático; `playing` subsequente → resume automático (sem menu de pause).

## Notas
- Armazenadas em array ordenado por `t` (as mensagens chegam em ordem).
- `sustain-extend` atualiza `sustainUntil`; `sustain-end` define `sustainEnd` (e `sustainUntil = sustainEnd`).
- Uma nota é removida quando `t` (ou `sustainEnd`) < `gameTime − 1s` e já foi julgada.

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

## Critérios de aceite
- [ ] Todas as transições da tabela cobertas por testes unitários com mocks.
- [ ] Input a exatamente `t ± 45ms` → PERFECT; `± 46ms` → GOOD; `± 136ms` → sem julgamento (e depois MISS pelo `tick`).
- [ ] Duas notas na mesma pista separadas por 100ms: dois toques corretos julgam cada uma (o primeiro não "consome" a segunda).
- [ ] Sustain de 1s segurado inteiro: `ticksAwarded = 10` (± 1).
- [ ] Seek durante PLAYING → SYNCING → PLAYING; o combo zera e o score se mantém.
- [ ] Anúncio no meio → AD → SYNCING → PLAYING sem notas do anúncio.
- [ ] Fim do vídeo → RESULTS só depois de o último áudio atrasado tocar.

## Testes
Vitest com relógio manual, sem DOM: sequências de `onAnalyzerMsg`/`onKeyDown`/`tick` com resultados esperados.
