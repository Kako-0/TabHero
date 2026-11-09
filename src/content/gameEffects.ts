// Ações das transições da spec 05 (tabela "Ações por transição") sobre grafo, vídeo,
// vídeo atrasado e relógio. main.tsx cria com as dependências reais; os testes, com mocks.
import type { AudioGraph } from "./audioGraph";
import type { GameClock } from "./clock";
import type { GameEffects } from "./game/game";
import type { VideoDelayBuffer } from "./videoDelay";
import { warn } from "@/shared/log";

export interface GameEffectsDeps {
  graph: Pick<
    AudioGraph,
    "setMode" | "flush" | "suspend" | "resume" | "dispose" | "setAnalysisActive"
  >;
  video: Pick<HTMLVideoElement, "currentTime" | "play" | "pause">;
  videoDelay: Pick<VideoDelayBuffer, "start" | "stop" | "clear">;
  clock: Pick<GameClock, "resync">;
  /**
   * Chamado antes de cada video.play()/pause() iniciado pelo jogo, para main.tsx marcar
   * o evento resultante e não devolvê-lo ao jogo (spec 06).
   */
  markOwnMediaEvent?: () => void;
  /** Restaura o <video> e remove o overlay (youtube.ts / ui). */
  onTeardown?: () => void;
}

export function createGameEffects(d: GameEffectsDeps): GameEffects {
  const play = () => {
    d.markOwnMediaEvent?.();
    d.video.play().catch((e: unknown) => warn("video.play() falhou", e));
  };
  const pause = () => {
    d.markOwnMediaEvent?.();
    d.video.pause();
  };

  return {
    enterGame() {
      d.graph.setMode("game");
      d.video.currentTime = 0;
      pause();
      d.videoDelay.start();
    },
    startPlayback() {
      play();
      d.clock.resync();
    },
    pause() {
      pause();
      void d.graph.suspend();
    },
    resume() {
      // A ctx precisa estar rodando antes do play, senão o começo do áudio some no buffer.
      void d.graph.resume().then(() => {
        play();
        d.clock.resync();
      });
    },
    flush() {
      d.graph.flush();
      d.videoDelay.clear();
      d.clock.resync();
    },
    setAnalysisActive(active) {
      d.graph.setAnalysisActive(active);
    },
    teardown() {
      d.graph.dispose();
      d.videoDelay.stop();
      d.onTeardown?.();
    },
  };
}
