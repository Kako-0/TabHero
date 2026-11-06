// Com o vídeo mudo ou no volume 0, a MediaElementSource entrega silêncio ao analisador
// (spec 01, SPIKE 2): não há notas, e o jogo avisa o usuário.

export function isSoundOff(video: HTMLMediaElement): boolean {
  return video.muted || video.volume === 0;
}

/** Chama `fn` quando o estado mudo/sem volume muda. Devolve a função de cancelamento. */
export function watchSound(video: HTMLMediaElement, fn: (soundOff: boolean) => void): () => void {
  let last = isSoundOff(video);
  const onChange = () => {
    const now = isSoundOff(video);
    if (now === last) return;
    last = now;
    fn(now);
  };
  video.addEventListener("volumechange", onChange);
  return () => video.removeEventListener("volumechange", onChange);
}
