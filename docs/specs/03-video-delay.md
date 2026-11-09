# 03 — Vídeo atrasado (`src/content/videoDelay.ts`)

## Objetivo
Mostrar o vídeo atrasado em `DELAY_S`, sincronizado com o áudio atrasado, como fundo do canvas do jogo.

## Fora de escopo
Desenhar as pistas (07). Conteúdo com DRM (só detectar).

## Interface

```ts
export interface VideoDelayBuffer {
  start(): void;                      // começa a capturar (requestVideoFrameCallback)
  stop(): void;                       // para e libera todos os frames
  clear(): void;                      // libera os frames (seek/flush); continua capturando
  /** Frame mais recente com procTime ≤ t, ou null. */
  frameAt(t: number): ImageBitmap | null;
  readonly drmSuspected: boolean;
  readonly stats: {
    frames: number; approxBytes: number; droppedCaptures: number;
    created: number; closed: number;  // vazamento: created − closed > frames
    decimated: boolean;               // orçamento estourado → 1 a cada 2 frames
  };
}

export function createVideoDelay(
  video: HTMLVideoElement,
  clock: Pick<GameClock, "procTimeAt" | "gameTime">,
  opts?: {
    audioRms?: () => number; // RMS do áudio sem atraso (DRM); ausente = DRM não verificado
    createBitmap?: (video) => Promise<ImageBitmap>; // injeção para testes
    isBlackFrame?: (video) => boolean;              // injeção para testes
  },
): VideoDelayBuffer;
```

## Comportamento
1. `start()` registra `video.requestVideoFrameCallback(onFrame)` e volta a registrar a cada callback.
2. `onFrame(now, metadata)`:
   - `procTime = clock.procTimeAt(metadata.expectedDisplayTime) + VIDEO_OFFSET_S` (SPIKE 1).
   - `createImageBitmap(video, { resizeWidth: FRAME_W, resizeHeight: FRAME_H, resizeQuality: "low" })`.
   - Se a criação anterior ainda estiver pendente, descarta este frame (`droppedCaptures++`). Nunca enfileira.
   - Insere em um array ordenado; remove (com `.close()`) os frames com `procTime < clock.gameTime() − 0,1`, ou além de `FRAME_BUFFER_S` de histórico.
3. `frameAt(t)`: busca binária; devolve o último frame com `procTime ≤ t`.
4. Durante pause (`ctx` suspensa) o vídeo também está pausado, então não chegam frames novos; o buffer permanece.
5. `clear()` em seek/flush; até chegar `DELAY_S` de material novo, `frameAt` devolve `null` e o render mostra o último frame exibido, escurecido (07).
6. **Esconder o original:** quando o jogo está ativo, o `<video>` recebe `opacity: 0` (via classe no `#movie_player`); ele continua decodificando normalmente.

### Detecção de DRM
Se os 10 primeiros frames forem inteiramente pretos (amostragem de 16 pixels via `OffscreenCanvas` 4×4) enquanto o áudio tem RMS > limiar, `drmSuspected = true`. O render usa fundo neutro + aviso.

### Orçamento
640×360×4 B ≈ 0,92 MB/frame. Com 30 fps e ~1,6s em regime, são ~48 frames ≈ 44 MB; com 60 fps, ~88 MB. **Se `stats.approxBytes` > 64 MB, capturar 1 a cada 2 frames.**

### Notas de implementação
- Constantes em `CONFIG`: `VIDEO_OFFSET_S` (0, provisório até o SPIKE 1), `FRAME_BUDGET_BYTES` (64 MB), `DRM_CHECK_FRAMES` (10), `DRM_BLACK_MAX` (16/255 por canal), `DRM_AUDIO_RMS` (0,003 ≈ −50 dBFS).
- O rVFC é re-registrado **antes** de qualquer trabalho no callback. O descarte de frames antigos roda a cada inserção: corte = `max(gameTime − 0,1, procTime do mais novo − FRAME_BUFFER_S)`, mas **o frame que `frameAt(gameTime)` devolve agora (e os mais novos) nunca é descartado**.
- **Piscadas (corrigido após o 1º teste manual):** com `FRAME_BUFFER_S = 1,6s`, o histórico necessário (`DELAY_S` + latência de saída ≈ 50ms + até 1 intervalo de frame + o adiantamento do `expectedDisplayTime`) ficava a poucos ms do limite. Qualquer jitter do rVFC descartava o frame da vez, e `frameAt` devolvia `null` por um instante, o que aparecia como uma piscada escura. O mesmo acontecia quando capturas descartadas abriam um buraco > 0,1s (regra `gameTime − 0,1`). Correção: proteger o frame atual e subir `FRAME_BUFFER_S` para 2,0s (aguenta latência de saída até ~0,4s). O teto de histórico só age quando `gameTime` está atrás de todos os frames; em regime, a memória continua sendo de ~`DELAY_S` + latência + 0,1s de frames. Testes de continuidade (24/30/60 fps, 144 Hz, latência 50ms e 200ms) em `tests/videoDelay.test.ts`.
- A inserção usa a mesma busca binária do `frameAt` (quase sempre cai no fim; a ordem só se inverte com correções da regressão do relógio).
- `clear()`/`stop()` incrementam uma geração: uma captura pendente de antes é fechada ao resolver e nunca entra no buffer. Após `clear()` a vaga de captura é liberada na hora, então o primeiro frame do trecho novo não é descartado.
- Orçamento: ao passar de `FRAME_BUDGET_BYTES`, a decimação 1-a-cada-2 fica ligada até o `stop()` (sem histerese, para não oscilar).
- **DRM:** conta frames pretos **com** áudio (`audioRms() > DRM_AUDIO_RMS`); frames pretos em silêncio (intro, fade) não contam. Um frame com imagem antes de 10 → verificação encerrada. Depois da suspeita, re-verifica 1 a cada 30 frames; um frame com imagem desfaz `drmSuspected` (reduz falso positivo em vídeos que começam pretos com som). Erro na leitura do `OffscreenCanvas` conta como "com imagem".
- Fonte do RMS: `AudioGraph.inputRms()` (01), um `AnalyserNode` (fftSize 2048) ligado à saída da `MediaElementSource`, criado no 1º uso e desligado no `dispose()`.
- **Esconder o original:** `YouTubePlayer.setGameActive(active)` (06) injeta `<style id="tabhero-style">` e alterna `tabhero-active` no `#movie_player`. Por enquanto só com a regra do `<video>`; o resto do CSS de partida entra com a spec 06.
- O render (07) **não pode guardar** o `ImageBitmap` devolvido por `frameAt` entre frames: o buffer pode fechá-lo (descarte, `clear`, `stop`). "Último frame exibido" = o que ficou no canvas (não redesenhar quando `frameAt` devolve `null`).
- Build de dev (`VITE_DEBUG=true`): o "Jogar" esconde o `<video>`, desenha `frameAt(gameTime())` em *cover* num canvas atrás do overlay (que já escurece 40%) e, em `seeking`, faz `graph.flush()` + `clear()` + `clock.resync()`. Loga a cada 2s: `stats`, `approxMB`, `leak` (= created − closed − frames, deve ser 0 ou 1 com captura em voo), `gaps` (vezes em que a tela ficou sem frame fora de início/seek; deve ser 0) e `drmSuspected`. Cada buraco também gera um aviso `sem frame (piscada)`.

### Roteiro dos testes manuais (M0, build de dev)
1. **Clap (SPIKE 1):** vídeo com claquete/palmas visíveis. Gravar a tela e o fone (ou filmar com o celular) e medir, quadro a quadro, a distância entre o frame da batida e o som. Repetir com 3–5 batidas; ajustar `VIDEO_OFFSET_S` e registrar aqui.
2. **1080p60:** confirmar `decimated: true` nos logs (60 fps × 1,6s ≈ 88 MB) e que a imagem segue fluida; anotar `droppedCaptures`.
3. **Memória 10 min:** DevTools → Memory / Performance monitor. `frames`, `approxMB` estáveis e `leak` ∈ {0, 1} o tempo todo.
4. **Custo:** perfil do DevTools durante ~10s; tempo de main thread do callback do rVFC + `createImageBitmap` < 2ms por frame.
5. **Seek:** pular para outro ponto; a tela fica no último frame escurecido por ~1,5s e nenhum frame do trecho anterior aparece.

## Critérios de aceite
- [x] Num vídeo de clap (imagem + som), o frame mostrado e o som atrasado coincidem em ± 1 frame (33ms a 30 fps).
- [x] Memória estável (sem crescimento) após 10 min de jogo; nenhum `ImageBitmap` vaza (contador de criados − fechados ≤ tamanho do buffer).
- [x] Custo de captura < 2ms por frame no main thread (perfil do DevTools) em máquina média.
- [x] Após seek, nenhum frame do trecho anterior aparece.

## Testes
- **Unitário:** ordenação, descarte, `frameAt` com clock mock. Feito em `tests/videoDelay.test.ts` (rVFC, bitmaps e relógio falsos): re-registro do rVFC, `procTime` com offset, captura pendente descarta, ordenação fora de ordem, `frameAt` por busca binária, descarte por `gameTime − 0,1` e por `FRAME_BUFFER_S`, decimação acima do orçamento, 10 min simulados a 30 fps sem vazamento, `clear` com captura pendente, `stop`, pause e os casos de DRM. `inputRms` em `tests/audioGraph.test.ts`.
- **Manual:** vídeo de clap; vídeo 1080p60; perfil de memória de 10 min.

## Riscos / SPIKE
1. **SPIKE: `VIDEO_OFFSET_S`.** O alinhamento entre o frame exibido e o áudio que entra no grafo pela `MediaElementSource` não é garantido. Medir com o vídeo de clap e fixar a constante aqui (esperado: −50ms a +50ms).
2. `createImageBitmap` com resize pode ser lento em algumas GPUs. Alternativa: `drawImage` num `OffscreenCanvas` reduzido + `transferToImageBitmap()`.
