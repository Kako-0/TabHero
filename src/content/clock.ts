// Stub (spec 02): relógio do jogo. Implementado no M0.
export interface Clock {
  /** procTime do som que o jogador está ouvindo agora (segundos, ctx). */
  gameTime(perf?: number): number;
}
