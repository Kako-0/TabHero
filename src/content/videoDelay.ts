// Stub (spec 03): vídeo atrasado em DELAY_S. Implementado no M0.
export interface VideoDelay {
  frameAt(procTime: number): ImageBitmap | null;
  dispose(): void;
}
