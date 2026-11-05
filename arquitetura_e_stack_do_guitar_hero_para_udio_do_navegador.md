# TabHero — Arquitetura e Stack

Extensão de navegador (Chrome, Manifest V3) que transforma o áudio de um vídeo do YouTube em um jogo de ritmo de 4 pistas, **gerado ao vivo**, renderizado como overlay sobre o player.

> **Nome:** "Guitar Hero" é marca registrada da Activision e não pode aparecer no nome, ícone ou listagem da Chrome Web Store. O nome público é **TabHero**.

---

## 0. Decisões do grill (resumo)

| Tema | Decisão | Motivo |
| :--- | :--- | :--- |
| Distribuição | **Chrome Web Store** | Permissões mínimas, sem download de conteúdo |
| Escopo MVP | **Só YouTube, só Chrome** | Um player conhecido para controlar e sobrepor |
| Modelo de análise | **Só look-ahead (ao vivo)**, sem gravação nem cache | Jogo instantâneo, sem preparo |
| Atraso (look-ahead) | **1,5s fixo** para áudio **e** vídeo | Notas visíveis ~1,3s antes do acerto; janela para análise e sustain |
| Sincronia de vídeo | **Vídeo atrasado em canvas** (ring buffer de frames) como fundo da pista | Vídeo, áudio e notas sincronizados; elimina a dessincronia que o look-ahead causava |
| UI do jogo | **Overlay sobre o player** (dentro do `#movie_player`) | Acompanha o modo cinema e a tela cheia; imersivo |
| Fonte de áudio | **`createMediaElementSource(video)`** no content script | Sem `tabCapture`, sem silenciar a aba, sem clique extra; `DelayNode` no próprio grafo |
| Relógio mestre | **`AudioContext.currentTime`** | O mesmo relógio da análise, do áudio atrasado e dos frames; congela sozinho no pause |
| Latência de saída | **Compensação automática** com `audioContext.outputLatency` | Custo ~zero; cobre parte do Bluetooth |
| Calibração manual | **Fora do MVP** | Slider de offset na v1.1 |
| Pause/seek | **Controlados pelo jogo** + recarga de 1,5s após seek | Evita áudio velho e notas fantasmas no buffer |
| Início da partida | **Botão "Jogar" no player → volta a 0:00 → contagem 3-2-1** | A contagem cobre o enchimento do buffer de 1,5s |
| Pistas / teclas | **4 pistas: `D` `F` `J` `K`** | — |
| Distribuição das notas | **Onset (spectral flux) + centroide espectral relativo**; pitch (`pitchy`) só para sustain | Capta ritmo (o LiveHero não capta) e é robusto em mistura |
| Libs de análise | **Meyda + pitchy (MIT)** | Funções puras: rodam no worklet e em Node |
| Mecânicas MVP | **Notas simples + janelas de acerto + sustain** | — |
| Sustain | **Envelope + estabilidade de pitch**, com cauda que cresce ao vivo | O fim da nota não precisa ser conhecido de antemão |
| Snap no BPM | **Fora do MVP** | O BPM ao vivo leva 5–10s para estabilizar; um snap errado é pior que ~10ms de jitter |
| Framework / render | **React (UI, em Shadow DOM) + Canvas 2D** | — |
| Qualidade do mapa | **Suíte de métricas + playtest** | — |

### Decisões revertidas em relação à versão anterior
- ~~Gravar primeiro em 2x + cache no IndexedDB~~: substituído pelo look-ahead com vídeo atrasado.
- ~~Side panel~~: o side panel não tem acesso aos frames do vídeo; o overlay tem.
- ~~`tabCapture`~~: substituído por `createMediaElementSource`.
- ~~Modo experimental de interceptar o stream do player~~: sem preparo, não há mais o que acelerar.

---

## 1. Fluxo geral

```
<video> do YouTube (som original substituído pelo grafo abaixo)
   │
   ├─ createMediaElementSource ─┬─► AudioWorklet (análise, sem atraso) ──► notas com tempo em ctx.currentTime
   │                            │
   │                            └─► DelayNode (1,5s) ──► GainNode ──► alto-falante
   │
   └─ requestVideoFrameCallback ──► ImageBitmap (640×360) ──► ring buffer de ~1,5s
                                                                │
Canvas do overlay (rAF):                                        │
   gameTime = ctx.currentTime − 1,5s − outputLatency            │
   fundo  = frame de (agora − 1,5s) ◄───────────────────────────┘
   pista  = notas com t em [gameTime − 0,15s, gameTime + 1,3s]
```

A análise sempre está **1,5s à frente** do que o jogador vê e ouve. Por isso a nota existe antes de chegar à linha de acerto.

### Por que não o modelo do LiveHero (referência analisada)
O [LiveHero](https://github.com/polywock/LiveHero) usa o mesmo princípio (`createMediaElementSource` + `DelayNode` de 1s), mas:
- **amostra o pitch a cada 100ms** no ritmo do `rAF`, sem detecção de onset, com erro de 0–115ms no início das notas;
- **não atrasa o vídeo**, então a imagem fica 1s adiantada;
- usa `Date.now()` como relógio, ignora `outputLatency` e não limpa o buffer do delay em pause/seek;
- esconde a imprecisão com uma janela de acerto de **±150ms**.

O TabHero corrige cada um desses pontos (§3–§5).

---

## 2. Componentes da extensão (MV3)

| Componente | Responsabilidade |
| :--- | :--- |
| **Content script** (`youtube.com/*`) | Injeta o botão "Jogar" na barra do player; cria o `AudioContext` (no clique, o que satisfaz a política de autoplay); monta o grafo de áudio; captura frames; renderiza o overlay (React em Shadow DOM + Canvas) dentro do `#movie_player`; controla `play/pause/seek`; detecta anúncios e navegação SPA. |
| **AudioWorklet** (`analyzer.worklet.ts`) | Recebe o áudio sem atraso, faz downmix para mono e reamostragem para 22.050 Hz, e roda a análise em streaming (§4). Envia notas por `port.postMessage` com o tempo em `ctx.currentTime`. |
| **Service worker** | Mínimo: configurações e página de opções. |
| **Storage** | `chrome.storage.sync` só para configurações. Não há cache de mapas. |

### Regras do grafo de áudio
- **Uma `MediaElementSource` por elemento, para sempre.** É criada uma vez e reutilizada; o YouTube mantém o mesmo `<video>` entre vídeos (navegação SPA).
- **Fora da partida**, a source conecta direto em `destination` (delay 0), e o som fica normal.
- Se `createMediaElementSource` lançar `InvalidStateError` (outra extensão já capturou o elemento), o jogo mostra um erro explicando o conflito. Não há fallback no MVP.
- O `AudioContext` precisa estar `running`; se for suspenso fora do controle do jogo, o vídeo fica mudo. Um listener em `statechange` resolve isso.

---

## 3. Relógio, atraso e sincronia

### Relógio único: `AudioContext.currentTime`
- **Notas:** o worklet marca cada nota com o tempo de contexto do frame de áudio em que o ataque ocorreu (`currentFrame / sampleRate`, corrigido pelo atraso interno da análise).
- **Tempo do jogo:** `gameTime = ctx.currentTime − DELAY − ctx.outputLatency`, com `DELAY = 1,5`. Para suavizar entre *render quanta*, usar `ctx.getOutputTimestamp()` e interpolar com `performance.now()`.
- **Input:** o `KeyboardEvent.timeStamp` (espaço do `performance.now()`) é convertido para tempo de contexto pelo par `{contextTime, performanceTime}` de `getOutputTimestamp()`. Assim o julgamento não depende de quando o handler rodou.
- **Pause** usa `ctx.suspend()`, que congela o relógio, o buffer do delay e a análise de uma vez (§5).

### Vídeo atrasado
- `video.requestVideoFrameCallback` dispara a cada frame novo: `createImageBitmap(video, { resizeWidth: 640, resizeHeight: 360 })`, guardado com o tempo de contexto correspondente (pela conversão via `getOutputTimestamp`).
- Ring buffer de ~1,6s: a 30 fps são ~48 frames × 0,9 MB ≈ **45 MB** (a 60 fps, reduzir para 480×270). Cada `ImageBitmap` é liberado com `.close()` ao sair do buffer.
- A cada `rAF`, desenha o frame mais recente com `t ≤ ctx.currentTime − DELAY − outputLatency`.
- O `<video>` original fica com `opacity: 0` (continua tocando e decodificando).
- **DRM:** conteúdo protegido desenha preto. Se o frame capturado vier vazio, o jogo mostra um fundo neutro com aviso.

### Compensação de latência
- `ctx.outputLatency` é somado automaticamente, e o valor é relido a cada 2s (ele muda quando o dispositivo de saída muda).
- **Limitação conhecida:** com Bluetooth, o valor reportado costuma subestimar o atraso real. Slider manual na v1.1.

---

## 4. Análise em streaming (AudioWorklet)

Entrada: PCM mono a 22.050 Hz, em blocos de 128 amostras (render quantum).

### Estratégia escolhida
| Papel | Técnica | Implementação |
| :--- | :--- | :--- |
| **Quando** há nota | Spectral flux (onset) | Meyda (`spectralFlux`) ou flux próprio sobre `fft.js` |
| **Em qual pista** | Centroide espectral relativo (janela móvel) | Meyda (`spectralCentroid`) |
| **Sustain** | Envelope (RMS) + estabilidade de pitch, avaliado **só depois de um onset** | Meyda (`rms`) + `pitchy` (MPM) |
| Densidade/BPM | Autocorrelação do flux (só para limitar densidade; sem snap) | Própria |

O `Meyda.extract()` é uma função pura, então roda no AudioWorklet e em Node (suíte de qualidade) com o mesmo código.

### Comparação com o LiveHero
O LiveHero só faz **pitch por amostragem** (`pitchy` a cada 100ms) e escolhe a pista por `round(4·log2(f/440) + 69) % 4` (pitch mod oitava). Notas na mesma pista são **fundidas** em sustain, e uma nota nova exige ≥ 250ms da anterior. Por isso ele ignora a percussão, junta notas repetidas numa só, tem no máximo 4 notas/s e erra o tempo em até ~115ms. O TabHero aproveita a ideia de pitch estável para sustain, mas o **onset vem antes**: o pitch só decide se uma nota já detectada se prolonga.

### Alternativas avaliadas (fora do MVP)
| Técnica | Por que ficou de fora |
| :--- | :--- |
| Energia/RMS pura para onset | Falha em música comprimida (tudo é "alto") |
| Flux por banda (grave/médio/agudo) | Candidato para a v1.1: permite priorizar bumbo/caixa |
| Pista por pitch mod oitava (LiveHero) ou chroma | Dá a volta na oitava; contraintuitivo |
| Pista por banda dominante | Desbalanceia as pistas |
| Clusters de timbre (MFCC + k-means) | Complexidade; candidato a experimento |
| **Basic Pitch** (Spotify, TF.js, Apache-2.0) | Transcrição polifônica de alta qualidade, mas processa janelas de ~2s, o que exige atraso de ~2,5s. Candidato a um "modo melodia" pós-MVP |

### Pipeline
1. **STFT incremental:** janela Hann de 2048, hop 256 (~11,6ms). São ~86 frames/s, abaixo de 1% de CPU, então rodar no worklet é aceitável.
2. **Onsets:** *spectral flux* (diferença positiva do log-magnitude) → threshold adaptativo `mediana + k·MAD` sobre uma janela **causal** de ~1s **+ 200ms de futuro** (consumidos do orçamento de 1,5s) → *peak picking* com intervalo mínimo de 60ms.
3. **Escolha da pista (contorno espectral):**
   - Centroide espectral e pitch dominante (YIN/chroma) nos ~50ms após o onset.
   - Normalização por quantis sobre uma **janela móvel dos últimos ~8s**: subiu → pista à direita.
   - Mapeamento para 4 pistas, com balanceamento pela janela móvel.
4. **Sustain ao vivo:**
   - Depois do onset, se a energia se mantém ≥ 60% do pico **e** o pitch fica estável (< 1 semitom) por ≥ 400ms, a nota vira sustain **aberto**.
   - O worklet envia `sustain-extend(id, t)` a cada ~50ms enquanto a condição vale, e `sustain-end(id, t)` quando ela cai.
   - Na tela, a cauda cresce no topo da pista; como a análise está 1,5s à frente, o jogador quase sempre vê a cauda inteira antes de chegar a ela.
5. **Pós-processamento jogável (causal):**
   - Intervalo mínimo por pista: 100ms.
   - Densidade máxima: ~8 notas/s (descarta o onset mais fraco dentro da janela).
   - Uma nota por instante (sem acordes).
   - Nada nos 2s após o início ou após um seek.

**Mensagens do worklet para o jogo:**

```ts
type AnalyzerMsg =
  | { type: "note"; id: number; t: number; lane: 0 | 1 | 2 | 3 }
  | { type: "sustain-extend"; id: number; until: number }
  | { type: "sustain-end"; id: number; end: number }
  | { type: "reset" };              // após seek
```

Todos os tempos estão em `ctx.currentTime`, ainda **sem** o atraso; o jogo aplica `DELAY + outputLatency`.

**Determinismo:** o mesmo vídeo pode gerar charts ligeiramente diferentes entre partidas (alinhamento dos frames de análise). Isso é aceitável no MVP.

---

## 5. Gameplay e controle do player

### Início
1. Botão **"Jogar"** injetado na barra de controles do player (`.ytp-right-controls`).
2. No clique: cria/resume o `AudioContext`, conecta o `DelayNode`, ativa o overlay, `video.currentTime = 0` e `play()`.
3. Contagem **3-2-1** (1,5s+) enquanto o buffer de atraso enche. As notas começam a chegar à linha logo depois.

### Pause
- Tecla de pause do jogo (`Espaço`; `Esc` também pausa fora da tela cheia, onde o navegador o reserva para sair do fullscreen), clique no overlay, ou os eventos `pause`/`waiting` do `<video>`:
  - `video.pause()` + `ctx.suspend()`: o relógio, o áudio atrasado (no meio do buffer) e o vídeo atrasado congelam juntos.
- Retomar: `ctx.resume()` + `video.play()`. O conteúdo do buffer continua de onde parou; uma diferença de dezenas de ms entre os dois resumes é aceitável.
- Atalhos de teclado do YouTube são interceptados enquanto o overlay está ativo. **Crítico:** `F` (tela cheia), `J` (−10s) e `K` (pause) do YouTube colidem com as teclas do jogo. Ver `docs/specs/06-youtube-integration.md`.

> Especificação detalhada por módulo: [`docs/specs/`](docs/specs/README.md).

### Seek
- Evento `seeking`:
  1. Recria o `DelayNode` (descarta 1,5s de áudio velho), limpa notas e o ring buffer de frames, e envia `reset` ao worklet.
  2. Overlay mostra **"sincronizando…"** por 1,5s.
  3. **O combo zera.** O score continua.

### Anúncios
- `#movie_player.ad-showing` → o jogo pausa a análise e o overlay mostra "anúncio". Quando o anúncio termina, o fluxo é o mesmo do seek (recarga de 1,5s).

### Julgamento
- **Teclas:** `D` `F` `J` `K`.
- **Janelas** (em relação a `gameTime`, com o timestamp do evento):

  | Julgamento | Janela |
  | :--- | :--- |
  | Perfect | ±45ms |
  | Good | ±90ms |
  | Miss | fora de ±135ms ou nota que passou |

- **Sustain:** a cabeça é julgada com as mesmas janelas; pontos por tick (100ms) com a tecla pressionada; soltar antes de `fim − 90ms` interrompe os ticks sem quebrar o combo.
- **Score:** pontos base × multiplicador de combo (1x → 4x a cada 10 acertos).
- **Fim:** evento `ended` → tela de resultados (acertos, erros, precisão, maior combo).

### Render
- Canvas 2D a 60 FPS, cobrindo o `#movie_player` (incluindo a tela cheia).
- Camadas: frame atrasado (escurecido ~40%) → pistas → notas/caudas → HUD.
- Notas mantidas num array ordenado por `t`; só as que estão na janela visível são desenhadas.

---

## 6. Stack

| Camada | Escolha |
| :--- | :--- |
| Linguagem | TypeScript 6 (strict), Node 26, Yarn 1.22.22 |
| UI (botão, HUD, menus, resultados) | React 19 em Shadow DOM, para isolar do CSS do YouTube |
| Render do jogo | Canvas 2D nativo |
| Build | Vite 8 + `@crxjs/vite-plugin` 3 (detalhes em `docs/specs/09-esqueleto-projeto.md`) |
| DSP | Meyda (MIT) para features, `pitchy` (MIT) para pitch, `fft.js` (MIT) se for preciso flux próprio |
| Testes | Vitest (unidades + suíte de qualidade em Node) |

**Licenças:** só dependências MIT/Apache-2.0. Essentia.js (AGPL-3.0), aubio e pitchfinder (GPL-3.0) foram descartados porque obrigariam a abrir o código da extensão.

### Manifest (essencial)

```json
{
  "manifest_version": 3,
  "name": "TabHero",
  "permissions": ["storage"],
  "host_permissions": ["https://www.youtube.com/*"],
  "background": { "service_worker": "src/background.ts", "type": "module" },
  "content_scripts": [{
    "matches": ["https://www.youtube.com/*"],
    "js": ["src/content/main.tsx"]
  }],
  "web_accessible_resources": [{
    "resources": ["analyzer.worklet.js"],
    "matches": ["https://www.youtube.com/*"]
  }]
}
```

### Estrutura de pastas

```
src/
  background.ts
  content/
    main.tsx                 # bootstrap, botão "Jogar", ciclo de vida
    youtube.ts               # seletores, eventos do player, anúncios, SPA
    audioGraph.ts            # MediaElementSource, DelayNode, suspend/resume, latência
    videoDelay.ts            # requestVideoFrameCallback + ring buffer de ImageBitmap
    clock.ts                 # gameTime, conversão de timestamps de evento
    game/                    # estado, julgamento, score, render Canvas
    ui/                      # React: HUD, contagem, pause, resultados
  analysis/                  # TS puro: roda no worklet e em Node
    stft.ts onset.ts lanes.ts sustain.ts postprocess.ts streamAnalyzer.ts
  worklet/analyzer.worklet.ts
quality/                     # suíte de qualidade (fora do bundle)
```

---

## 7. Qualidade do gerador

**Métricas (regressão):**
- ~10 faixas variadas (rock, EDM, acústico, rap, pop, instrumental) com licença livre e onsets anotados.
- Os arquivos passam pelo **mesmo `streamAnalyzer`** em blocos de 128 amostras, simulando o tempo real em Node.
- **F1 de onset** (±50ms), **erro médio de tempo** das notas, densidade (notas/s), distribuição por pista (cada pista entre 15% e 40%) e sustains falsos em trechos de pad.
- O CI falha se o F1 cair mais de 2 pontos.

**Playtest:** checklist por música ("as notas seguem a melodia?", "algum trecho frustrante?", "o vídeo parece sincronizado?"). Ajustes registrados por versão do analisador.

---

## 8. Riscos e pontos a validar

| Risco | Impacto | Mitigação / validação |
| :--- | :--- | :--- |
| **Carregar o AudioWorklet a partir do content script** (`audioWorklet.addModule` com URL `chrome-extension://` numa página do YouTube; CSP/Trusted Types) | Bloqueia a arquitetura | **Spike do M0.** Fallbacks: módulo via Blob URL; análise no main thread com `AnalyserNode` |
| Outra extensão já criou `MediaElementSource` no `<video>` | Jogo não inicia | Mensagem de erro clara; `tabCapture` como fallback pós-MVP |
| `outputLatency` subestimado em Bluetooth | Notas fora do tempo para quem usa BT | Slider manual na v1.1 |
| `video.volume`/`muted` aplicados ou não ao sinal da `MediaElementSource` | Análise falha com volume baixo ou mudo | Validar no M0; o threshold adaptativo é relativo, mas mudo = silêncio |
| Memória/CPU do ring buffer de frames em 60 fps / 4K | Travamentos | Resolução fixa reduzida; medir no M0 |
| Mudanças no DOM do YouTube | Botão/overlay/anúncio quebram | Seletores centralizados em `content/youtube.ts` |
| Músicas sem ataques claros | Pista vazia | Aviso "música pouco rítmica" |
| Variação do chart entre partidas | Sensação de inconsistência | Aceito no MVP; cache opcional no futuro |

---

## 9. Roadmap

1. **M0 — Spikes:** worklet carregando no YouTube; `MediaElementSource` + `DelayNode` 1,5s; ring buffer de vídeo atrasado medindo memória/CPU; verificar `outputLatency`; sincronia validada a olho e com metrônomo.
2. **M1 — Analisador em streaming:** onsets + pistas, em Node, com a suíte de qualidade.
3. **M2 — Jogo jogável:** overlay, botão "Jogar", contagem, `D F J K`, julgamento, score/combo, pause/seek/anúncio.
4. **M3 — Sustain ao vivo:** extensão de cauda, ticks de pontuação.
5. **M4 — Polimento:** tela de resultados, tela cheia, tratamento de erros, assets e listagem da Web Store.
6. **Pós-MVP:** slider de latência, dificuldades, remapeamento de teclas, snap no BPM, cache de charts, fallback com `tabCapture`, outros sites.
