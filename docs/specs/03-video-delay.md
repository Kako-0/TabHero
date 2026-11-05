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
  readonly stats: { frames: number; approxBytes: number; droppedCaptures: number };
}

export function createVideoDelay(video: HTMLVideoElement, clock: GameClock): VideoDelayBuffer;
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
640×360×4 B ≈ 0,92 MB/frame. Com 30 fps e 1,6s, são ~48 frames ≈ 44 MB; com 60 fps, ~88 MB. **Se `stats.approxBytes` > 64 MB, capturar 1 a cada 2 frames.**

## Critérios de aceite
- [ ] Num vídeo de clap (imagem + som), o frame mostrado e o som atrasado coincidem em ± 1 frame (33ms a 30 fps).
- [ ] Memória estável (sem crescimento) após 10 min de jogo; nenhum `ImageBitmap` vaza (contador de criados − fechados ≤ tamanho do buffer).
- [ ] Custo de captura < 2ms por frame no main thread (perfil do DevTools) em máquina média.
- [ ] Após seek, nenhum frame do trecho anterior aparece.

## Testes
- **Unitário:** ordenação, descarte, `frameAt` com clock mock.
- **Manual:** vídeo de clap; vídeo 1080p60; perfil de memória de 10 min.

## Riscos / SPIKE
1. **SPIKE: `VIDEO_OFFSET_S`.** O alinhamento entre o frame exibido e o áudio que entra no grafo pela `MediaElementSource` não é garantido. Medir com o vídeo de clap e fixar a constante aqui (esperado: −50ms a +50ms).
2. `createImageBitmap` com resize pode ser lento em algumas GPUs. Alternativa: `drawImage` num `OffscreenCanvas` reduzido + `transferToImageBitmap()`.
