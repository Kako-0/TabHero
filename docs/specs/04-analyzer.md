# 04 — Analisador em streaming (`src/analysis/`, `src/worklet/`)

## Objetivo
Transformar o áudio sem atraso em eventos de nota (`AnalyzerMsg`) com tempo em `procTime`, com no máximo `ANALYSIS_LOOKAHEAD_S` de atraso de decisão, de forma que a nota esteja disponível antes de precisar aparecer na pista.

**Orçamento de tempo:** a nota precisa estar no jogo até `t + DELAY_S − VISIBLE_LEAD_S` = `t + 0,25s`. O analisador usa até `0,2s` (lookahead) + processamento.

## Fora de escopo
BPM/snap, acordes, dificuldades, ML.

## Estrutura

```
src/analysis/            # puro: sem DOM, sem Web Audio; roda no worklet e em Node
  resampler.ts           # entrada SR do ctx → 22.050 Hz, preservando o mapeamento de tempo
  stft.ts                # janelamento Hann 2048 / hop 256
  features.ts            # wrappers do Meyda (flux, centroide, rms) e pitchy (pitch, clarity)
  onset.ts               # threshold adaptativo + peak picking
  lanes.ts               # centroide relativo → pista
  sustain.ts             # máquina de estado do sustain
  postprocess.ts         # gaps, densidade, blank após reset
  streamAnalyzer.ts      # orquestra tudo
src/worklet/analyzer.worklet.ts   # AudioWorkletProcessor que chama o streamAnalyzer
```

## Interface

```ts
export interface StreamAnalyzer {
  /** Bloco mono no SR de entrada; t0 = procTime da primeira amostra. */
  push(block: Float32Array, t0: number): AnalyzerMsg[];
  reset(at: number): void;
}
export function createStreamAnalyzer(inputSampleRate: number, cfg = CONFIG): StreamAnalyzer;
```

Worklet: em `process(inputs)`, faz downmix dos canais para mono e chama `push(mono, currentFrame / sampleRate)`; as mensagens vão via `this.port.postMessage`. Os comandos `reset`/`set-active` chegam pela porta. Com `active = false`, o `process` devolve `true` sem analisar.

## Pipeline

### 1. Reamostragem e quadros
- Reamostragem linear para 22.050 Hz (suficiente para as features usadas). Cada quadro de análise guarda o `procTime` da sua **amostra central**.
- Quadro = 2048 amostras, hop = 256 (~11,6ms; ~86 quadros/s).

### 2. Features por quadro
- `flux`: spectral flux positivo sobre o log-magnitude (`log(1 + 10·|X|)`), somado entre 30 Hz e 8 kHz.
- `centroid`: centroide espectral (Hz).
- `rms`.
- `pitch` + `clarity` (`pitchy`, MPM): **só** calculados em quadros dentro de um candidato a sustain (economia).

### 3. Onsets
- Função de detecção: `flux` suavizado (média de 3 quadros).
- Threshold adaptativo: `thr = mediana(janela) + K·MAD(janela) + δ`, janela de **1s passado + 0,2s futuro** (os 0,2s vêm do lookahead). Iniciais: `K = 1,5`, `δ = 0,02·max_móvel`. Calibrados na suíte (08).
- Pico = máximo local (±3 quadros) acima de `thr`, a ≥ `ONSET_MIN_GAP_S` do onset anterior.
- O tempo do onset é o `procTime` do quadro de pico − `ANALYZER_OFFSET_S` (constante de correção medida na suíte; inicial 0).
- `strength = (flux − thr) / thr`.

### 4. Pista (centroide relativo)
- `c` = mediana do centroide nos ~50ms após o onset (5 quadros).
- Histórico: os centroides dos onsets nos últimos `LANE_WINDOW_S`.
- Com ≥ 12 onsets no histórico: `lane` = quartil de `log(c)` dentro do histórico (Q1 → 0 … Q4 → 3).
- Com menos: limites fixos em `log(c)` (300, 1000, 2500 Hz).
- **Anti-jackhammer:** se as 3 últimas notas estão na mesma pista e o centroide mudou menos de 5%, mantém a pista (permitido). Não há regra de mudança forçada.

### 5. Pós-processamento (causal)
Uma nota candidata é **descartada** se:
- ocorre < `BLANK_AFTER_RESET_S` após o início ou após `reset`;
- já existe nota na mesma pista a < `LANE_MIN_GAP_S`; nesse caso, se a nova é mais forte, a nova vai para a pista adjacente mais próxima em centroide, se livre, senão é descartada;
- já há `MAX_NOTES_PER_S` notas emitidas no último 1s. Como a emissão é imediata, não há troca por uma nota mais forte; a escolha do mais forte acontece antes, no *peak picking* dentro do lookahead.

### 6. Sustain (M3)
Máquina de estados por nota emitida (só a nota mais recente pode virar sustain):

```
TAP ──(rms ≥ SUSTAIN_ENERGY_RATIO·pico E pitch estável ± 1 semitom E clarity ≥ 0,6, por SUSTAIN_MIN_S)──► SUSTAIN
SUSTAIN ──(rms cai abaixo do limiar OU pitch muda > 1 semitom por 3 quadros OU novo onset na mesma pista)──► ENDED
```
- Ao entrar em SUSTAIN: emite `sustain-extend(id, until = t + SUSTAIN_MIN_S)`.
- Enquanto em SUSTAIN: `sustain-extend(id, until = procTime atual)` a cada `SUSTAIN_EXTEND_INTERVAL_S`.
- Ao terminar: `sustain-end(id, end)`.
- Um onset novo em **outra** pista **não** termina o sustain, mas a nota nova não pode virar sustain enquanto houver outro ativo (MVP: no máximo um sustain por vez).
- O "pico" é o rms máximo nos 50ms após o onset.

### 7. `reset(at)`
Limpa buffers, histórico de pistas e sustain ativo (emite `sustain-end` para ele), ignora amostras com `procTime < at` e emite `reset-ack`.

## Critérios de aceite
- [ ] Mesmo código executado no worklet e em Node (`quality/`) produz as mesmas notas para o mesmo áudio (determinismo para entrada idêntica).
- [ ] Latência de decisão: toda `note` é emitida até `t + 0,22s` em `procTime` (medido no worklet).
- [ ] CPU no worklet < 15% do orçamento do render quantum (sem *glitches* no áudio atrasado) num notebook médio.
- [ ] Suíte (08): F1 de onset ≥ 0,70 (M1), distribuição por pista entre 15% e 40% em todas as faixas.
- [ ] Testes sintéticos (abaixo) passam.

## Testes (Vitest, Node)
| Teste | Entrada sintética | Esperado |
| :--- | :--- | :--- |
| Clicks | Clicks a 120 BPM por 10s | 1 nota por click após o blank, erro ≤ 12ms |
| Silêncio | 10s de zeros | 0 notas |
| Ruído branco constante | 10s | ≤ 2 notas |
| Escada de tons | 8 tons ascendentes, 500ms cada, com ataque | Pistas não decrescentes depois de 12 onsets |
| Sustain | Tom de 440 Hz por 1,5s com ataque | 1 nota + `sustain-end` em ≈ 1,5s (± 60ms) |
| Notas repetidas | 4 ataques do mesmo tom, 250ms cada | 4 notas (não um sustain), diferente do LiveHero |
| Densidade | Clicks a 20/s | ≤ 8 notas em qualquer janela de 1s |
| Reset | Clicks; `reset` no meio | Nenhuma nota com `t < at + BLANK_AFTER_RESET_S` |

## Riscos
- Meyda/`pitchy` em `AudioWorkletGlobalScope`: ver SPIKE 1 da spec 01. Plano B: implementar flux/centroide/rms em TS sobre `fft.js` (simples) e YIN próprio.
- Música muito comprimida (EDM, metal): o flux fica alto o tempo todo. Ajustar `K` por faixa na suíte; considerar flux por banda na v1.1.
