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
  /** Atalho para gameTimeAt(performance.now()), monotônico não decrescente. */
  gameTime(): number;
  /** Latência total aplicada (s), para debug/HUD. */
  latency(): number;
  /** As duas fontes medidas (SPIKE 1), para debug/HUD. `null` = ainda sem medida. */
  latencySources(): { outputLatency: number; outputTimestamp: number | null };
  /** Descarta amostras (chamar após resume e após flush). */
  resync(): void;
  /** Chamado a cada rAF pelo loop do jogo. */
  sample(): void;
}

export function createClock(
  graph: Pick<AudioGraph, "ctx" | "getOutputLatency">,
  opts?: {
    now?: () => number; // injeção para testes
    latencySource?: LatencySource; // SPIKE 1
    onResync?: (reason: "manual" | "state" | "outlier") => void; // debug
  },
): GameClock;
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

### Notas de implementação
- Constantes em `CONFIG`: `CLOCK_WINDOW` (60), `CLOCK_MIN_SAMPLES` (10), `CLOCK_SLOPE_MIN/MAX` (0,999/1,001), `CLOCK_OUTLIER_S` (50ms), `LATENCY_SOURCE`.
- A regressão usa `perf − perf da 1ª amostra` como x (evita perda de precisão com `performance.now()` grande).
- Sem nenhuma amostra (logo após `resync`), `procTimeAt(perf) = ctx.currentTime + (perf − now)/1000`.
- `sample()` faz `resync()` sozinho quando `ctx.state` muda (cobre `resume`/`suspend`/`interrupted`) e quando uma amostra cai a mais de `CLOCK_OUTLIER_S` da reta (troca de dispositivo, aba estrangulada). Após `flush()` o jogo chama `resync()` explicitamente. Dois `sample()` com o mesmo `perf` contam uma vez.
- `gameTime()` tem trava monotônica: correções da regressão para trás de até `CLOCK_OUTLIER_S` são seguradas no último valor; uma maior passa (erro real). `gameTimeAt()` não tem a trava (input usa timestamps passados).
- Fonte A = `graph.getOutputLatency()` (já suavizada no 01). Fonte B = mediana das últimas 60 medidas cruas (descarta `contextTime`/`performanceTime` zerados e valores fora de [0, 1s]) com o mesmo `LatencySmoother` de 5ms/s; até a primeira medida B válida, usa A.
- Build de dev (`VITE_DEBUG=true`): o "Jogar" inicia um loop rAF que chama `sample()` e loga a cada 2s `gameTime`, desvio vs `currentTime` e as latências A e B — insumo para o SPIKE 1. Desde a spec 06, o "Jogar" inicia a partida real (também no build de produção); o log de dev da partida, a cada 2s, traz estado, `gameTime`, desvio, latências A/B, score, combo, frames, `approxMB`, `leak` e `drmSuspected`.

## Critérios de aceite
- [ ] `gameTime()` é monotônico não decrescente entre frames, sem saltos > 5ms, fora de seek/resync.
- [x] Desvio entre `procTimeAt(performance.now())` e `ctx.currentTime` < 3ms (média de 10s). Medido: ±0,02ms (rodada 2, fone sem fio).
- [ ] Com a `ctx` suspensa, `gameTime()` fica constante; depois do resume, continua do mesmo valor (± 5ms).
- [ ] Teste de metrônomo: vídeo com clicks a 120 BPM e notas sintéticas forçadas nos clicks; a nota cruza a linha de acerto no momento do som (± 15ms com o fone sem fio 2,4 GHz, medido por gravação).

## Testes
- **Unitário:** regressão com amostras sintéticas com jitter; suspensão; resync.
- **Manual (M0):** teste de metrônomo acima, com o fone sem fio 2,4 GHz (registrar os desvios encontrados aqui). **Escopo do MVP: só essa saída.** Fone com fio, alto-falante e Bluetooth ficam para depois do MVP.

### Resultados M0 (2026-11-06)
Log do build de dev (`VITE_DEBUG=true`), uma sessão de ~36s, 48 kHz. Saída: fone sem fio 2,4 GHz e, a partir de ~186s, o alto-falante do notebook (troca feita durante a sessão). Cada linha é um instantâneo a cada 2s (não é a média de 10s do critério). O teste de metrônomo ainda não foi feito: depende do vídeo atrasado (03) e do render (07).

| Trecho / saída | Latência A | Latência B | A − B |
| :--- | ---: | ---: | ---: |
| 169,6 → 185,7s — fone sem fio 2,4 GHz | 50,0ms | 47,5–47,8ms | ≈ +2,3ms |
| 189,6 → 205,6s — alto-falante do notebook | 58,0ms | 57,2–57,8ms | ≈ +0,6ms |

- **Desvio `procTimeAt(now) − currentTime`** (19 instantâneos): média −0,4ms, média do módulo 2,5ms, faixa −5,8 a +5,3ms. A média atende o critério de < 3ms. Os picos de ±5ms são compatíveis com o Chrome atualizando `currentTime` em blocos maiores que 128 amostras.
- **Descontinuidade em ~186s:** `currentTime` ficou 51,6ms atrás da reta (o áudio parou de avançar). O resync automático disparou, e nesse intervalo de 2s o `gameTime` avançou 1,918s em vez de ~2,007s, acompanhando o áudio. A causa foi a troca do fone para o alto-falante do notebook, e a latência de saída subiu de 50 para 58ms.
- **A e B concordaram dentro de 2,5ms** nos dois regimes, e as duas acompanharam a mudança de latência. Na época da mudança, B chegou ao novo valor ~2s antes, porque é medida a cada frame, enquanto A é consultada a cada `OUTPUT_LATENCY_POLL_MS`. Só o teste de metrônomo vai dizer qual das duas é mais correta.
- Fone com fio e Bluetooth: fora do escopo do MVP (só fone sem fio 2,4 GHz).

<details>
<summary>Log bruto</summary>

```
[TabHero] grafo de áudio pronto {sampleRate: 48000}
[TabHero] relógio {gameTime: '169.610', driftMs: '0.10', latencyA_ms: '50.0', latencyB_ms: null}
[TabHero] relógio {gameTime: '171.609', driftMs: '-0.89', latencyA_ms: '50.0', latencyB_ms: '47.6'}
[TabHero] relógio {gameTime: '173.616', driftMs: '2.93', latencyA_ms: '50.0', latencyB_ms: '47.6'}
[TabHero] relógio {gameTime: '175.623', driftMs: '1.92', latencyA_ms: '50.0', latencyB_ms: '47.8'}
[TabHero] relógio {gameTime: '177.629', driftMs: '-2.37', latencyA_ms: '50.0', latencyB_ms: '47.5'}
[TabHero] relógio {gameTime: '179.636', driftMs: '-5.76', latencyA_ms: '50.0', latencyB_ms: '47.8'}
[TabHero] relógio {gameTime: '181.643', driftMs: '1.01', latencyA_ms: '50.0', latencyB_ms: '47.7'}
[TabHero] relógio {gameTime: '183.651', driftMs: '0.78', latencyA_ms: '50.0', latencyB_ms: '47.8'}
[TabHero] relógio {gameTime: '185.657', driftMs: '-3.80', latencyA_ms: '50.0', latencyB_ms: '47.8'}
[TabHero] relógio: descontinuidade, resync {errMs: -51.56206387692919}
[TabHero] relógio {gameTime: '187.575', driftMs: '5.28', latencyA_ms: '50.0', latencyB_ms: '47.5'}
[TabHero] relógio {gameTime: '189.579', driftMs: '-1.23', latencyA_ms: '50.2', latencyB_ms: '57.3'}
[TabHero] relógio {gameTime: '191.578', driftMs: '-5.12', latencyA_ms: '58.0', latencyB_ms: '57.3'}
[TabHero] relógio {gameTime: '193.586', driftMs: '2.34', latencyA_ms: '58.0', latencyB_ms: '57.8'}
[TabHero] relógio {gameTime: '195.592', driftMs: '-1.70', latencyA_ms: '58.0', latencyB_ms: '57.4'}
[TabHero] relógio {gameTime: '197.598', driftMs: '-3.60', latencyA_ms: '58.0', latencyB_ms: '57.5'}
[TabHero] relógio {gameTime: '199.605', driftMs: '3.35', latencyA_ms: '58.0', latencyB_ms: '57.3'}
[TabHero] relógio {gameTime: '201.612', driftMs: '-1.13', latencyA_ms: '58.0', latencyB_ms: '57.4'}
[TabHero] relógio {gameTime: '203.621', driftMs: '-1.94', latencyA_ms: '58.0', latencyB_ms: '57.2'}
[TabHero] relógio {gameTime: '205.625', driftMs: '1.89', latencyA_ms: '58.0', latencyB_ms: '57.3'}
```
</details>

### Resultados M0 — rodada 2: média de 10s (2026-11-06)
Método: o build de dev mede `procTimeAt(p) − currentTime` em **todo frame** (com `p = performance.now()` lido junto do `currentTime`) e loga `relógio 10s` a cada janela de 10s: média com sinal, média do módulo, máximo do módulo e média das latências A e B. Janelas com resync ou `ctx` suspensa são descartadas (`janela descartada`). O critério "< 3ms" vale para a **média com sinal**: o serrote dos saltos do `currentTime` é inevitável, e a regressão existe para passar pelo meio dele. A média do módulo e o máximo ficam como indicação de jitter.

Roteiro: ≥ 60s sem trocar de dispositivo durante a janela. No MVP, só com o fone sem fio 2,4 GHz; outras saídas ficam para depois do MVP.

Sessão: 6 janelas seguidas (60s), 48 kHz, nenhum resync e nenhuma janela descartada. Saída: fone sem fio 2,4 GHz.

| Saída | Janelas | Desvio médio (com sinal) | Média do módulo | Máx. do módulo | Latência A | Latência B | A − B |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Fone sem fio 2,4 GHz | 6 | −0,01 a +0,02ms | 2,49–2,51ms | 5,96–6,47ms | 50,00ms | 47,03–47,24ms | 2,76–2,97ms |

**Insights**
- **A regressão não tem viés.** O desvio médio com sinal fica em ±0,02ms, mais de 100× abaixo do limite de 3ms. Critério atendido com folga. A média de −0,4ms da rodada 1 era ruído de amostragem (19 instantâneos).
- **O `currentTime` do Chrome anda em degraus de ~10ms, não de 128 amostras.** Num serrote uniforme de passo T, a média do módulo do desvio em relação à reta é T/4 e o máximo é T/2. Medido: 2,5ms → T ≈ 10ms (= 480 amostras a 48 kHz), e máximo de ~6ms ≈ 5ms + jitter de agendamento. Os números são estáveis entre janelas (2,49–2,51ms), o que reforça que é estrutural, não ruído. Consequência: sem a regressão, render e input veriam erros de até ±5ms; com ela o erro sistemático some. Por isso a regressão é necessária (e não apenas "suavização").
- **A diferença A − B é estável dentro da sessão: ~2,9ms (±0,1ms).** A é constante (50,00ms); B oscila só 0,2ms entre janelas. Hipótese a investigar: ~2,9ms ≈ um quantum de render (128/48000 = 2,67ms), o que sugeriria que uma das fontes conta um bloco a mais. Mas no alto-falante a diferença foi 0,6ms (rodada 1), então não é um offset fixo: depende do dispositivo.
- **B varia entre sessões; A não.** No mesmo fone, B foi 47,5–47,8ms na rodada 1 e 47,0–47,2ms agora (−0,5ms), enquanto A deu 50,0ms nas duas. Ponto a favor de A em estabilidade, embora estabilidade não seja o mesmo que exatidão; quem decide ainda é o teste de metrônomo.
- **Taxa de frames:** n ≈ 1440 por janela → monitor de 144 Hz. A última janela teve 1396 (~3% de frames perdidos), sem efeito visível no desvio.

<details>
<summary>Log bruto (rodada 2)</summary>

```
[TabHero] relógio 10s {n: 1436, driftMeanMs: '-0.00', driftMeanAbsMs: '2.51', driftMaxAbsMs: '6.47', latencyA_ms: '50.00', latencyB_ms: '47.15'}
[TabHero] relógio 10s {n: 1436, driftMeanMs: '-0.01', driftMeanAbsMs: '2.51', driftMaxAbsMs: '6.16', latencyA_ms: '50.00', latencyB_ms: '47.07'}
[TabHero] relógio 10s {n: 1441, driftMeanMs: '-0.01', driftMeanAbsMs: '2.51', driftMaxAbsMs: '6.22', latencyA_ms: '50.00', latencyB_ms: '47.03'}
[TabHero] relógio 10s {n: 1441, driftMeanMs: '-0.01', driftMeanAbsMs: '2.51', driftMaxAbsMs: '6.35', latencyA_ms: '50.00', latencyB_ms: '47.06'}
[TabHero] relógio 10s {n: 1439, driftMeanMs: '-0.01', driftMeanAbsMs: '2.50', driftMaxAbsMs: '6.30', latencyA_ms: '50.00', latencyB_ms: '47.20'}
[TabHero] relógio 10s {n: 1396, driftMeanMs: '0.02', driftMeanAbsMs: '2.49', driftMaxAbsMs: '5.96', latencyA_ms: '50.00', latencyB_ms: '47.24'}
```
</details>

## Riscos / SPIKE
1. **SPIKE: qual fonte de latência é correta no Chrome?**
   - **A:** `latency = ctx.outputLatency + ctx.baseLatency`.
   - **B:** `latency = procTimeAt(ts.performanceTime) − ts.contextTime` com `ts = ctx.getOutputTimestamp()`.

   Medir as duas no teste de metrônomo. Escolher a de menor erro e registrar aqui. **Nunca somar as duas.**
   - Implementadas as duas; a escolha é `CONFIG.LATENCY_SOURCE` (`"output-latency"` = A, padrão provisório; `"output-timestamp"` = B). **Resultado:** primeira medição (ver "Resultados M0" acima) mostra A e B a até 2,5ms uma da outra; a escolha final depende do teste de metrônomo. **Preferência atual: A**, por ser mais estável (50,0ms constante no fone nas duas rodadas, contra 47,5–47,8ms e depois 47,0–47,2ms de B). Na rodada 2, A − B ficou estável em ~2,9ms dentro da sessão, mas foi 0,6ms no alto-falante: a diferença depende do dispositivo. Decidir de vez depois das specs 03 e 07.
2. Bluetooth: espera-se erro residual de 50–200ms. Documentar o valor medido; a correção é o slider manual pós-MVP.
