# 02 — Relógio e sincronia (`src/content/clock.ts`)

## Objetivo
Converter entre o tempo de `performance.now()` e o tempo de processamento do `AudioContext` (`procTime`), e calcular `gameTime`, de forma suave, monotônica (exceto em seek) e compensada pela latência de saída.

## Fora de escopo
Pausar/retomar (é responsabilidade do grafo de áudio, 01). O relógio apenas reflete a `ctx`.

## Interface

```ts
export interface GameClock {
  /** procTime estimado no instante perf (ms de performance.now / Event.timeStamp). */
  procTimeAt(perfMs: number): number;
  /** Tempo que está sendo ouvido no instante perf. */
  heardTimeAt(perfMs: number): number;
  /** heardTimeAt(perf) − DELAY_S. Base de todo o jogo. */
  gameTimeAt(perfMs: number): number;
  /** Atalho para gameTimeAt(performance.now()). */
  gameTime(): number;
  /** Latência total aplicada (s), para debug/HUD. */
  latency(): number;
  /** Descarta amostras (chamar após resume e após flush). */
  resync(): void;
  /** Chamado a cada rAF pelo loop do jogo. */
  sample(): void;
}

export function createClock(graph: AudioGraph): GameClock;
```

## Comportamento

### Mapeamento perf → procTime
- A cada `sample()` (rAF), registra o par `(performance.now(), ctx.currentTime)`.
- `ctx.currentTime` avança em saltos de 128 amostras (~2,7ms a 48 kHz). Para suavizar, mantém uma **regressão linear sobre as últimas 60 amostras** (inclinação travada entre 0,999 e 1,001 por segundo de perf).
- `procTimeAt(perf) = a + b·perf`. Enquanto houver menos de 10 amostras, usa a amostra mais recente + `(perf − perfAmostra)/1000`.
- `resync()` limpa as amostras. É chamado em `resume`, `flush` e `statechange`.
- Com a `ctx` suspensa: `procTimeAt` devolve o último `ctx.currentTime` (relógio congelado).

### Latência
- `latency()` = valor da fonte escolhida no SPIKE 1 abaixo.
- `heardTimeAt(perf) = procTimeAt(perf) − latency()`.
- `gameTimeAt(perf) = heardTimeAt(perf) − DELAY_S`.

### Uso pelos outros módulos
| Consumidor | Chamada |
| :--- | :--- |
| Render (rAF) | `clock.sample(); const now = clock.gameTime();` |
| Input | `clock.gameTimeAt(event.timeStamp)` |
| Vídeo atrasado (03) | Grava o frame com `procTimeAt(metadata.expectedDisplayTime)`; mostra o frame com `procTime ≤ gameTime()` |
| Analisador | Já emite em `procTime` (via `currentFrame` do worklet) |

## Critérios de aceite
- [ ] `gameTime()` é monotônico não decrescente entre frames, sem saltos > 5ms, fora de seek/resync.
- [ ] Desvio entre `procTimeAt(performance.now())` e `ctx.currentTime` < 3ms (média de 10s).
- [ ] Com a `ctx` suspensa, `gameTime()` fica constante; depois do resume, continua do mesmo valor (± 5ms).
- [ ] Teste de metrônomo: vídeo com clicks a 120 BPM e notas sintéticas forçadas nos clicks; a nota cruza a linha de acerto no momento do som (± 15ms com fone com fio, medido por gravação).

## Testes
- **Unitário:** regressão com amostras sintéticas com jitter; suspensão; resync.
- **Manual (M0):** teste de metrônomo acima, com fone com fio, alto-falante e Bluetooth (registrar os desvios encontrados aqui).

## Riscos / SPIKE
1. **SPIKE: qual fonte de latência é correta no Chrome?**
   - **A:** `latency = ctx.outputLatency + ctx.baseLatency`.
   - **B:** `latency = procTimeAt(ts.performanceTime) − ts.contextTime` com `ts = ctx.getOutputTimestamp()`.

   Medir as duas no teste de metrônomo. Escolher a de menor erro e registrar aqui. **Nunca somar as duas.**
2. Bluetooth: espera-se erro residual de 50–200ms. Documentar o valor medido; a correção é o slider manual pós-MVP.
