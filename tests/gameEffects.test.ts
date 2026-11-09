import { describe, expect, it, vi } from "vitest";
import { createGame } from "@/content/game/game";
import { createGameEffects, type GameEffectsDeps } from "@/content/gameEffects";
import { CONFIG } from "@/shared/config";

/** Mocks das dependências com um log único, para conferir a ordem das chamadas. */
function deps() {
  const calls: string[] = [];
  const rec =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push(args.length ? `${name}(${args.map(String).join(",")})` : name);
      return ret;
    };
  const video = {
    _t: 42,
    get currentTime() {
      return this._t;
    },
    set currentTime(v: number) {
      calls.push(`video.currentTime=${v}`);
      this._t = v;
    },
    play: vi.fn(rec("video.play", Promise.resolve())),
    pause: vi.fn(rec("video.pause")),
  };
  const d = {
    graph: {
      setMode: vi.fn(rec("graph.setMode")),
      flush: vi.fn(rec("graph.flush")),
      suspend: vi.fn(rec("graph.suspend", Promise.resolve())),
      resume: vi.fn(rec("graph.resume", Promise.resolve())),
      dispose: vi.fn(rec("graph.dispose")),
      setAnalysisActive: vi.fn(rec("graph.setAnalysisActive")),
    },
    video,
    videoDelay: {
      start: vi.fn(rec("videoDelay.start")),
      stop: vi.fn(rec("videoDelay.stop")),
      clear: vi.fn(rec("videoDelay.clear")),
    },
    clock: { resync: vi.fn(rec("clock.resync")) },
    markOwnMediaEvent: vi.fn(rec("mark")),
    onTeardown: vi.fn(rec("onTeardown")),
  };
  return { d: d as unknown as GameEffectsDeps, calls };
}

const microtasks = () => new Promise((r) => setTimeout(r, 0));

describe("ações por transição (spec 05)", () => {
  it("IDLE → COUNTDOWN e play no meio da contagem", () => {
    const { d, calls } = deps();
    const game = createGame(createGameEffects(d));
    game.start();
    expect(calls).toEqual([
      "graph.setMode(game)",
      "video.currentTime=0",
      "mark(pause)",
      "video.pause",
      "videoDelay.start",
    ]);
    calls.length = 0;
    game.tick(0);
    game.tick(CONFIG.VIDEO_PLAY_AT_COUNTDOWN_S);
    expect(calls).toEqual(["mark(play)", "video.play", "clock.resync"]);
  });

  it("→ PAUSED e PAUSED → RESUMING → PLAYING (play só depois da ctx retomar)", async () => {
    const { d, calls } = deps();
    const game = createGame(createGameEffects(d));
    game.start();
    game.tick(0);
    game.tick(CONFIG.COUNTDOWN_S);
    calls.length = 0;
    game.pause();
    expect(calls).toEqual(["mark(pause)", "video.pause", "graph.suspend"]);
    calls.length = 0;
    game.resume();
    // Contagem: nada é retomado até o fim dela.
    game.tick(CONFIG.COUNTDOWN_S, 0);
    expect(calls).toEqual([]);
    game.tick(CONFIG.COUNTDOWN_S, CONFIG.RESUME_COUNTDOWN_S);
    expect(calls).toEqual(["graph.resume"]);
    await microtasks();
    expect(calls).toEqual(["graph.resume", "mark(play)", "video.play", "clock.resync"]);
  });

  it("pause por buffering: só suspende o grafo (o <video> segue esperando dados)", () => {
    const { d, calls } = deps();
    const game = createGame(createGameEffects(d));
    game.start();
    game.tick(0);
    game.tick(CONFIG.COUNTDOWN_S);
    calls.length = 0;
    game.pause("buffering");
    expect(calls).toEqual(["graph.suspend"]);
  });

  it("→ SYNCING (seek): flush do grafo, clear do vídeo e resync", () => {
    const { d, calls } = deps();
    const game = createGame(createGameEffects(d));
    game.start();
    game.tick(0);
    game.tick(CONFIG.COUNTDOWN_S);
    calls.length = 0;
    game.seeked();
    expect(calls).toEqual(["graph.flush", "videoDelay.clear", "clock.resync"]);
  });

  it("→ AD desliga a análise; AD → SYNCING religa e descarta o buffer", () => {
    const { d, calls } = deps();
    const game = createGame(createGameEffects(d));
    game.start();
    game.tick(0);
    game.tick(CONFIG.COUNTDOWN_S);
    calls.length = 0;
    game.adStarted();
    expect(calls).toEqual(["graph.setAnalysisActive(false)"]);
    calls.length = 0;
    game.adEnded();
    expect(calls).toEqual([
      "graph.setAnalysisActive(true)",
      "graph.flush",
      "videoDelay.clear",
      "clock.resync",
    ]);
  });

  it("→ RESULTS não mexe em grafo/vídeo", () => {
    const { d, calls } = deps();
    const game = createGame(createGameEffects(d));
    game.start();
    game.tick(0);
    game.tick(CONFIG.COUNTDOWN_S);
    calls.length = 0;
    game.ended(CONFIG.COUNTDOWN_S + 1);
    game.tick(CONFIG.COUNTDOWN_S + 1);
    expect(game.state).toBe("RESULTS");
    expect(calls).toEqual([]);
  });

  it("→ IDLE: dispose do grafo, stop do vídeo atrasado, restaura o player", () => {
    const { d, calls } = deps();
    const game = createGame(createGameEffects(d));
    game.start();
    calls.length = 0;
    game.exit();
    expect(calls).toEqual(["graph.dispose", "videoDelay.stop", "onTeardown"]);
  });
});
