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
  autoGain.ts            # normalização de volume (etapa 0)
  stft.ts                # janelamento Hann 2048 / hop 256 (fft.js) + buffer circular de amostras
  features.ts            # flux, centroide e rms sobre o fft.js; pitchy (pitch, clarity)
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
  /** Descarta o estado; devolve `sustain-end` (se havia sustain ativo) e `reset-ack`. */
  reset(at: number): AnalyzerMsg[];
}
export function createStreamAnalyzer(inputSampleRate: number, cfg: AnalyzerConfig = CONFIG): StreamAnalyzer;
```

`reset` devolve as mensagens (em vez de `void`) para o worklet postar o `reset-ack` na hora, sem esperar o próximo `push`.

**Buraco no fluxo:** se o `t0` de um bloco não continua o anterior (ex.: `set-active` false → true), o analisador recomeça como num início novo (encerra o sustain ativo e aplica o blank).

Worklet: em `process(inputs)`, faz downmix dos canais para mono e chama `push(mono, currentFrame / sampleRate)`; as mensagens vão via `this.port.postMessage`. Os comandos `reset`/`set-active` chegam pela porta. Com `active = false`, o `process` devolve `true` sem analisar.

## Pipeline

### 0. Normalização de volume (`autoGain.ts`)
O sinal chega já multiplicado por `video.volume` (spec 01, SPIKE 2), e o `log(1 + 10·|X|)` do flux não é invariante à escala. Por isso, antes de tudo:
- Ganho = `AGC_TARGET_RMS / √(média móvel do quadrado)`, com média exponencial de constante `AGC_TAU_S` (3s) e limite `AGC_MAX_GAIN` (+60 dB).
- Blocos com RMS < `AGC_SILENCE_RMS` (−100 dBFS; ex.: mudo) não atualizam a média, e o ganho fica congelado.
- A média é no domínio linear, robusta a trechos quietos da música. Consequência: subir o volume converge rápido (< 3× o alvo em 0,5s), e baixar o volume 20× leva ~8 τ (~24s) para convergir (−6 dB em 5 τ). Os limiares adaptativos absorvem essa diferença.
- O ganho **não** é zerado em `reset` (o volume do usuário não muda com o seek).

### 1. Reamostragem e quadros
- Reamostragem linear para 22.050 Hz (suficiente para as features usadas). Cada quadro de análise guarda o `procTime` da sua **amostra central**.
- Quadro = 2048 amostras, hop = 256 (~11,6ms; ~86 quadros/s).
- **Lookahead em quadros:** o quadro i só fica completo meia janela (46ms) depois do seu centro. Por isso o lookahead é o que sobra do orçamento: `floor((ANALYSIS_LOOKAHEAD_S − 1024/22050) / hop) = 13` quadros (0,15s). A nota do quadro i sai quando o quadro i+13 completa, ~0,197s depois do centro de i.

### 2. Features por quadro
- `flux`: spectral flux positivo sobre o log-magnitude (`log(1 + 10·|X|)`), somado entre 30 Hz e 8 kHz.
- `centroid`: centroide espectral (Hz).
- `rms`.
- `pitch` + `clarity` (`pitchy`, MPM): **só** calculados em quadros dentro de um candidato a sustain (economia).

### 3. Onsets
- Função de detecção: `flux` suavizado (média de 3 quadros).
- Threshold adaptativo: `thr = mediana(janela) + K·MAD(janela) + δ`, janela de **1s passado + o lookahead (13 quadros)**. Iniciais: `K = ONSET_K = 1,5`, `δ = ONSET_DELTA_RATIO·max_móvel = 0,1·max_móvel` (com 0,02, ruído branco constante gerava ~18 notas em 10s; com 0,05, ~5). Calibrados na suíte (08).
- Pico = máximo local (±3 quadros) acima de `thr`, a ≥ `ONSET_MIN_GAP_S` do onset anterior.
- **Gate de energia:** o fim de uma nota também gera flux positivo (o truncamento dentro da janela espalha energia por muitos bins, e o `log` amplifica bins quase vazios). O onset só vale se `rms(quadro i+4) ≥ ONSET_ENERGY_GATE·rms(quadro i−4)` (janelas inteiras depois/antes do pico; gate inicial 0,8).
- O tempo do onset é o `procTime` do pico (quadro de pico + interpolação parabólica sub-quadro) − `ANALYZER_OFFSET_S`. Medido nos sintéticos: o pico do flux sai −17,5ms antes nos clicks e −13,7ms antes nos tons com ataque (a janela "vê" o ataque pela borda). Valor inicial `−0,016`; a suíte refina com música.
- `strength = (flux − thr) / thr`.

### 4. Pista (centroide relativo)
- `c` = mediana do centroide nos ~50ms após o onset (5 quadros).
- Histórico: os centroides dos onsets nos últimos `LANE_WINDOW_S`.
- Com ≥ 12 onsets no histórico: `lane` = quartil de `log(c)` dentro do histórico (Q1 → 0 … Q4 → 3).
- Com menos: limites fixos em `log(c)` (300, 1000, 2500 Hz).
- O histórico inclui todos os onsets detectados, mesmo os descartados no pós-processamento (ex.: no blank), para aquecer os quartis.
- **Anti-jackhammer:** se as 3 últimas notas estão na mesma pista e o centroide mudou menos de 5%, mantém a pista (permitido). Não há regra de mudança forçada.

### 5. Pós-processamento (causal)
Uma nota candidata é **descartada** se:
- ocorre < `BLANK_AFTER_RESET_S` após o início ou após `reset`;
- já existe nota na mesma pista a < `LANE_MIN_GAP_S`; nesse caso, se a nova é mais forte, a nova vai para a pista adjacente mais próxima em centroide, se livre, senão é descartada;
- já há `MAX_NOTES_PER_S` notas emitidas no último 1s. Como a emissão é imediata, não há troca por uma nota mais forte; a escolha do mais forte acontece antes, no *peak picking* dentro do lookahead.

### 6. Sustain (M3)
Máquina de estados por nota emitida (só a nota mais recente pode virar sustain):

```
TAP ──(rms ≥ SUSTAIN_ENERGY_RATIO·pico E pitch estável ± 1 semitom E clarity ≥ SUSTAIN_MIN_CLARITY (0,6), por SUSTAIN_MIN_S)──► SUSTAIN
SUSTAIN ──(rms cai abaixo do limiar OU pitch muda > 1 semitom por 3 quadros OU novo onset na mesma pista)──► ENDED
```
- Ao entrar em SUSTAIN: emite `sustain-extend(id, until = t + SUSTAIN_MIN_S)`.
- Enquanto em SUSTAIN: `sustain-extend(id, until = procTime atual)` a cada `SUSTAIN_EXTEND_INTERVAL_S`.
- Ao terminar: `sustain-end(id, end)`.
- Um onset novo em **outra** pista **não** termina o sustain, mas a nota nova não pode virar sustain enquanto houver outro ativo (MVP: no máximo um sustain por vez).
- O "pico" é o rms máximo nos 50ms após o onset.
- A avaliação começa 4 quadros após o onset (janela já toda depois do ataque); "pitch estável" é relativo ao pitch do primeiro quadro avaliado. Pitch só é calculado nesses quadros.
- O sustain anda nos quadros já decididos (atrasados pelo lookahead), na mesma ordem dos onsets; `until` é o `procTime` desse quadro.
- No fim por pitch, `end` = primeiro dos 3 quadros fora; nesses quadros não sai `sustain-extend`.

### 7. `reset(at)`
Limpa buffers, histórico de pistas e sustain ativo (emite `sustain-end` para ele), ignora amostras com `procTime < at` e emite `reset-ack`.

## Critérios de aceite
- [x] Mesmo código executado no worklet e em Node (`quality/`) produz as mesmas notas para o mesmo áudio (determinismo para entrada idêntica). Coberto em `tests/analyzer.test.ts`; com blocos de tamanho diferente, só o ponto flutuante muda (< 2ms, pelo AGC por bloco).
- [ ] Latência de decisão: toda `note` é emitida até `t + 0,22s` em `procTime` (medido no worklet). Em Node, em blocos de 128: ≤ 0,2s (teste). **Pendente:** medir no worklet.
- [ ] CPU no worklet < 15% do orçamento do render quantum (sem *glitches* no áudio atrasado) num notebook médio. Em Node (WSL2): média 1,3%, pior bloco após o aquecimento 0,69ms de 2,67ms. **Pendente:** medir no Chrome.
- [ ] Suíte (08): F1 de onset ≥ 0,70 (M1), distribuição por pista entre 15% e 40% em todas as faixas. **Pendente:** depende do dataset e do `quality/run.ts` (spec 08).
- [x] Testes sintéticos (abaixo) passam.

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

Os tons sintéticos têm release de 30ms (um corte de 2ms é um click de verdade e gera onset). A escada usa 3 passadas de 8 tons (180 Hz–4,5 kHz), para exercitar os quartis depois de 12 onsets.

## Riscos
- Meyda/`pitchy` em `AudioWorkletGlobalScope`: ver SPIKE 1 da spec 01. Plano B: implementar flux/centroide/rms em TS sobre `fft.js` (simples) e YIN próprio.

  **Resposta (M1):** adotado o plano B para as features espectrais (o flux pedido, `log(1 + 10·|X|)` entre 30 Hz e 8 kHz, não é o do Meyda; flux/centroide/rms sobre o `fft.js` são poucas linhas). O `pitchy` continua (MPM). O bundle IIFE do worklet (`fft.js` + `pitchy`) não referencia `window`/`document`. O Meyda não é mais usado. **Pendente:** confirmar no `/watch`.
- Música muito comprimida (EDM, metal): o flux fica alto o tempo todo. Ajustar `K` por faixa na suíte; considerar flux por banda na v1.1.
