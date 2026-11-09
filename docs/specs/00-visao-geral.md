# 00 — Visão geral e convenções

## Objetivo do produto
Extensão Chrome (MV3) que, num vídeo do YouTube, gera ao vivo um jogo de ritmo de 4 pistas a partir do áudio e o desenha como overlay sobre o player. O áudio e o vídeo ficam atrasados 1,5s para que as notas apareçam antes do som.

## Escopo do MVP
- Só `https://www.youtube.com/watch*`, só Chrome desktop.
- Início sempre do 0:00, com contagem 3-2-1.
- 4 pistas (`D` `F` `J` `K`), notas simples e sustain.
- Pause, seek, anúncios e fim do vídeo tratados.
- Tela de resultados.

## Fora do escopo do MVP
Calibração manual de latência, dificuldades, remapeamento de teclas, snap no BPM, cache de charts, efeitos sonoros, tela de configurações, recordes, outros sites, fallback com `tabCapture`, Firefox, mobile.

## Mapa de módulos
Estrutura completa de diretórios, build e ferramentas: [09 — Esqueleto do projeto](09-esqueleto-projeto.md).

```
content/main.tsx ──► youtube.ts (DOM do player, eventos, teclado)
       │
       ├──► audioGraph.ts ──► worklet/analyzer.worklet.ts ──► analysis/streamAnalyzer.ts
       │          │                                                   │ (AnalyzerMsg)
       ├──► clock.ts ◄────────┘                                       ▼
       ├──► videoDelay.ts ──────────────────────────────────► game/ (estado, julgamento, score)
       │                                                              │
       └──► ui/ (React, Shadow DOM) ◄──── game/render.ts (Canvas) ◄───┘
```

Dependências permitidas: `analysis/` é **puro**, sem DOM nem APIs de áudio, e roda no worklet e em Node. `game/` não conhece o DOM do YouTube; recebe eventos de `youtube.ts` via `main.tsx`.

## Glossário de tempos

| Termo | Definição | Unidade |
| :--- | :--- | :--- |
| **tempo de processamento** (`procTime`) | Posição na linha do tempo do `AudioContext` em que uma amostra **entra** no grafo; é o `currentFrame / sampleRate` do worklet | segundos (ctx) |
| **tempo ouvido** (`heardTime(perf)`) | `procTime` da amostra que está saindo no alto-falante no instante `perf` | segundos (ctx) |
| **`gameTime(perf)`** | `heardTime(perf) − DELAY_S`: o `procTime` original do som que o jogador está ouvindo agora | segundos (ctx) |
| `perf` | `performance.now()` ou `Event.timeStamp` | ms |
| tempo de mídia | `video.currentTime`; **não** é usado no jogo, só para início/seek | segundos |

**Regra:** toda nota, frame e evento de input é expresso em **`procTime`**. A comparação é sempre contra `gameTime`.

## Constantes compartilhadas (`src/shared/config.ts`)

```ts
export const CONFIG = {
  DELAY_S: 1.5,               // atraso do áudio e do vídeo
  VISIBLE_LEAD_S: 1.25,       // quanto tempo a nota leva do topo da pista até a linha de acerto
  COUNTDOWN_S: 3.0,
  VIDEO_PLAY_AT_COUNTDOWN_S: 1.5, // video.play() nesse instante da contagem → som começa no "GO"
  SYNC_AFTER_SEEK_S: 1.5,

  ANALYSIS_SR: 22050,
  FFT_SIZE: 2048,
  HOP: 256,
  ANALYSIS_LOOKAHEAD_S: 0.2,
  AGC_TARGET_RMS: 0.1,        // ganho automático na entrada do analisador (independe de video.volume)
  AGC_TAU_S: 3,
  AGC_MAX_GAIN: 1000,         // +60 dB
  AGC_SILENCE_RMS: 1e-5,      // −100 dBFS: abaixo disso o ganho fica congelado
  ONSET_K: 1.5,
  ONSET_DELTA_RATIO: 0.1,
  ONSET_MIN_GAP_S: 0.06,
  ONSET_ENERGY_GATE: 0.8,
  ANALYZER_OFFSET_S: -0.016,
  LANE_MIN_GAP_S: 0.1,
  MAX_NOTES_PER_S: 8,
  LANE_WINDOW_S: 8,
  BLANK_AFTER_RESET_S: 2,
  SUSTAIN_MIN_S: 0.4,
  SUSTAIN_ENERGY_RATIO: 0.6,
  SUSTAIN_PITCH_TOLERANCE_SEMITONES: 1,
  SUSTAIN_MIN_CLARITY: 0.6,
  SUSTAIN_EXTEND_INTERVAL_S: 0.05,

  LANES: 4,
  KEYS: ["KeyD", "KeyF", "KeyJ", "KeyK"] as const,
  WINDOW_PERFECT_S: 0.045,
  WINDOW_GOOD_S: 0.09,
  WINDOW_MISS_S: 0.135,
  SUSTAIN_TICK_S: 0.1,
  SUSTAIN_RELEASE_TOLERANCE_S: 0.09,
  SCORE_PERFECT: 100,
  SCORE_GOOD: 50,
  SCORE_TICK: 10,
  COMBO_STEP: 10,
  MAX_MULTIPLIER: 4,

  FRAME_W: 640,
  FRAME_H: 360,
  FRAME_BUFFER_S: 2.0,
  VIDEO_DIM: 0.4,
  OUTPUT_LATENCY_POLL_MS: 2000,
} as const;
```

Os parâmetros de análise são ajustáveis pela suíte de qualidade (08). Os demais só mudam com atualização desta spec.

## Tipos compartilhados (`src/shared/types.ts`)

```ts
export type Lane = 0 | 1 | 2 | 3;

export type AnalyzerMsg =
  | { type: "note"; id: number; t: number; lane: Lane; strength: number }
  | { type: "sustain-extend"; id: number; until: number }
  | { type: "sustain-end"; id: number; end: number }
  | { type: "reset-ack"; at: number };

export type AnalyzerCmd =
  | { type: "reset"; at: number }      // descarta estado; ignora áudio antes de `at` (procTime)
  | { type: "set-active"; active: boolean };
```

## Convenções
- TypeScript `strict`; sem `any` em interfaces públicas.
- Licenças de dependências: só MIT, Apache-2.0, BSD ou ISC.
- Logs com prefixo `[TabHero]`, e só com `CONFIG.DEBUG` ativo no build de dev.
- Toda string visível em pt-BR, centralizada em `src/shared/strings.ts`.

## Permissões (manifest)
`storage` + `host_permissions: ["https://www.youtube.com/*"]`. Nenhuma outra permissão sem atualizar esta spec.
