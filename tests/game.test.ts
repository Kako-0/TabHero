import { describe, expect, it, vi } from "vitest";
import { createGame, type GameEffects, type GameState } from "@/content/game/game";
import { CONFIG } from "@/shared/config";
import type { Lane } from "@/shared/types";

function mockEffects() {
  return {
    enterGame: vi.fn(),
    startPlayback: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    flush: vi.fn(),
    setAnalysisActive: vi.fn(),
    teardown: vi.fn(),
  } satisfies GameEffects;
}

/** Relógio manual: avança o gameTime em passos de ~60 fps chamando tick. */
function setup() {
  const fx = mockEffects();
  const game = createGame(fx);
  const states: GameState[] = [];
  game.on("state", (s) => states.push(s));
  let gt = 100;
  const advance = (dt: number, step = 1 / 60) => {
    const end = gt + dt;
    while (gt + step < end) {
      gt += step;
      game.tick(gt);
    }
    gt = end;
    game.tick(gt);
  };
  const now = () => gt;
  /** IDLE → COUNTDOWN → PLAYING. */
  const play = () => {
    game.start();
    game.tick(gt);
    advance(CONFIG.COUNTDOWN_S);
    expect(game.state).toBe("PLAYING");
  };
  let id = 0;
  const note = (t: number, lane: Lane = 0) => {
    game.onAnalyzerMsg({ type: "note", id: ++id, t, lane, strength: 1 });
    return id;
  };
  return { fx, game, states, advance, now, play, note };
}

describe("máquina de estados", () => {
  it("IDLE → COUNTDOWN: enterGame, zera stats; play no meio da contagem; PLAYING após COUNTDOWN_S", () => {
    const { fx, game, states, advance } = setup();
    expect(game.state).toBe("IDLE");
    game.start();
    expect(fx.enterGame).toHaveBeenCalledTimes(1);
    expect(game.state).toBe("COUNTDOWN");
    game.tick(100);
    expect(game.countdown).toBeCloseTo(3);
    advance(CONFIG.VIDEO_PLAY_AT_COUNTDOWN_S - 0.05);
    expect(fx.startPlayback).not.toHaveBeenCalled();
    advance(0.1);
    expect(fx.startPlayback).toHaveBeenCalledTimes(1);
    expect(game.countdown).toBeCloseTo(
      CONFIG.COUNTDOWN_S - CONFIG.VIDEO_PLAY_AT_COUNTDOWN_S - 0.05,
    );
    advance(CONFIG.COUNTDOWN_S - CONFIG.VIDEO_PLAY_AT_COUNTDOWN_S - 0.1);
    expect(game.state).toBe("COUNTDOWN");
    advance(0.05);
    expect(game.state).toBe("PLAYING");
    expect(game.countdown).toBeNull();
    expect(fx.startPlayback).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["COUNTDOWN", "PLAYING"]);
  });

  it("PLAYING → PAUSED → PLAYING chama pause/resume; pause automático guarda o motivo", () => {
    const { fx, game, play } = setup();
    play();
    game.pause();
    expect(game.state).toBe("PAUSED");
    expect(game.pauseReason).toBe("user");
    expect(fx.pause).toHaveBeenCalledWith("user");
    game.resume();
    expect(game.state).toBe("PLAYING");
    expect(fx.resume).toHaveBeenCalledTimes(1);
    game.pause("buffering");
    expect(game.pauseReason).toBe("buffering");
    game.resume();
    expect(game.pauseReason).toBeNull();
  });

  it("pause/resume fora de PLAYING/PAUSED é ignorado", () => {
    const { fx, game } = setup();
    game.pause();
    game.resume();
    game.start();
    game.pause();
    expect(game.state).toBe("COUNTDOWN");
    expect(fx.pause).not.toHaveBeenCalled();
    expect(fx.resume).not.toHaveBeenCalled();
  });

  it("seek: PLAYING → SYNCING (flush, apaga notas, combo 0, score mantido) → PLAYING", () => {
    const { fx, game, advance, now, play, note } = setup();
    play();
    for (let i = 0; i < 5; i++) {
      note(now() + 0.5 + i * 0.2);
    }
    for (let i = 0; i < 5; i++) {
      advance(i === 0 ? 0.5 : 0.2);
      game.onKeyDown(0, now());
      game.onKeyUp(0, now());
    }
    expect(game.stats.combo).toBe(5);
    const score = game.stats.score;
    note(now() + 1);
    game.seeked();
    expect(game.state).toBe("SYNCING");
    expect(fx.flush).toHaveBeenCalledTimes(1);
    expect(game.stats.combo).toBe(0);
    expect(game.stats.score).toBe(score);
    expect(game.visibleNotes(-Infinity, Infinity)).toHaveLength(0);
    advance(CONFIG.SYNC_AFTER_SEEK_S - 0.05);
    expect(game.state).toBe("SYNCING");
    advance(0.1);
    expect(game.state).toBe("PLAYING");
    expect(game.stats.miss).toBe(0);
  });

  it("após o flush, ignora mensagens do analisador até o reset-ack", () => {
    const { game, now, play, note } = setup();
    play();
    game.seeked();
    note(now() + 0.5); // em trânsito, de antes do reset
    expect(game.visibleNotes(-Infinity, Infinity)).toHaveLength(0);
    game.onAnalyzerMsg({ type: "reset-ack", at: now() });
    note(now() + 3);
    expect(game.visibleNotes(-Infinity, Infinity)).toHaveLength(1);
  });

  it("anúncio no meio: AD → SYNCING → PLAYING sem notas do anúncio nem MISS", () => {
    const { fx, game, states, advance, now, play, note } = setup();
    play();
    note(now() + 0.5);
    game.adStarted();
    expect(game.state).toBe("AD");
    expect(fx.setAnalysisActive).toHaveBeenLastCalledWith(false);
    // Mensagens que ainda chegam durante o anúncio são descartadas.
    note(now() + 1);
    advance(10);
    expect(game.visibleNotes(-Infinity, Infinity)).toHaveLength(0);
    game.adEnded();
    expect(fx.setAnalysisActive).toHaveBeenLastCalledWith(true);
    expect(fx.flush).toHaveBeenCalledTimes(1);
    expect(game.state).toBe("SYNCING");
    advance(CONFIG.SYNC_AFTER_SEEK_S + 0.05);
    expect(game.state).toBe("PLAYING");
    expect(game.stats.miss).toBe(0);
    expect(states).toEqual(["COUNTDOWN", "PLAYING", "AD", "SYNCING", "PLAYING"]);
    // Notas novas, após o reset-ack, voltam a ser aceitas.
    game.onAnalyzerMsg({ type: "reset-ack", at: now() });
    note(now() + 2);
    expect(game.visibleNotes(-Infinity, Infinity)).toHaveLength(1);
  });

  it("anúncio também interrompe COUNTDOWN e SYNCING", () => {
    const a = setup();
    a.game.start();
    a.game.adStarted();
    expect(a.game.state).toBe("AD");
    const b = setup();
    b.play();
    b.game.seeked();
    b.game.adStarted();
    expect(b.game.state).toBe("AD");
  });

  it("fim do vídeo → RESULTS só depois de o último áudio atrasado tocar", () => {
    const { game, advance, now, play, note } = setup();
    play();
    const endAt = now() + CONFIG.DELAY_S + 0.03; // procTime do fim (inclui a latência de saída)
    note(endAt - 0.1);
    game.ended(endAt);
    advance(CONFIG.DELAY_S);
    expect(game.state).toBe("PLAYING");
    advance(0.02);
    game.onKeyDown(0, now()); // última nota ainda jogável
    expect(game.stats.good + game.stats.perfect).toBe(1);
    advance(0.02);
    expect(game.state).toBe("RESULTS");
  });

  it("ended sem endAt espera DELAY_S de gameTime; notas não alcançadas viram MISS", () => {
    const { game, advance, now, play, note } = setup();
    play();
    note(now() + CONFIG.DELAY_S + 0.05);
    game.ended();
    advance(CONFIG.DELAY_S - 0.02);
    expect(game.state).toBe("PLAYING");
    advance(0.04);
    expect(game.state).toBe("RESULTS");
    expect(game.stats.miss).toBe(1);
  });

  it("RESULTS → start → COUNTDOWN (jogar de novo, stats zerados); exit → IDLE", () => {
    const { fx, game, advance, now, play, note } = setup();
    play();
    note(now() + 0.2);
    game.ended(now() + 0.5);
    advance(1);
    expect(game.state).toBe("RESULTS");
    expect(game.stats.miss).toBe(1);
    game.start();
    expect(game.state).toBe("COUNTDOWN");
    expect(fx.enterGame).toHaveBeenCalledTimes(2);
    expect(game.stats.miss).toBe(0);
    game.exit();
    expect(game.state).toBe("IDLE");
    expect(fx.teardown).toHaveBeenCalledTimes(1);
  });

  it("exit de qualquer estado → IDLE com teardown; em IDLE é no-op", () => {
    const { fx, game, play } = setup();
    game.exit();
    expect(fx.teardown).not.toHaveBeenCalled();
    play();
    game.pause();
    game.exit();
    expect(game.state).toBe("IDLE");
    expect(fx.teardown).toHaveBeenCalledTimes(1);
  });

  it("erro → ERROR (com código) → exit → IDLE", () => {
    const { fx, game, play } = setup();
    play();
    game.fail("SOURCE_TAKEN");
    expect(game.state).toBe("ERROR");
    expect(game.errorCode).toBe("SOURCE_TAKEN");
    game.exit();
    expect(game.state).toBe("IDLE");
    expect(game.errorCode).toBeNull();
    expect(fx.teardown).toHaveBeenCalledTimes(1);
  });
});

describe("julgamento", () => {
  const cases: [number, string | null][] = [
    [0, "PERFECT"],
    [0.045, "PERFECT"],
    [-0.045, "PERFECT"],
    [0.046, "GOOD"],
    [-0.046, "GOOD"],
    [0.09, "GOOD"],
    [0.1, "MISS"],
    [-0.135, "MISS"],
    [0.136, null],
    [-0.136, null],
  ];
  it.each(cases)("input a t %+fs → %s", (delta, expected) => {
    const { game, advance, now, play, note } = setup();
    play();
    const t = now() + 0.5;
    note(t, 2);
    advance(0.5 + Math.min(delta, 0.1)); // o tick não pode passar da janela antes do toque
    game.onKeyDown(2, t + delta);
    if (expected === null) {
      expect(game.lastJudgement(2)).toBeNull();
      advance(0.5);
      expect(game.lastJudgement(2)?.j).toBe("MISS"); // pelo tick
    } else {
      expect(game.lastJudgement(2)?.j).toBe(expected);
    }
  });

  it("ghost press (sem nota na janela) não penaliza", () => {
    const { game, now, play, note } = setup();
    play();
    note(now() + 1);
    game.onKeyDown(0, now());
    expect(game.stats).toMatchObject({ miss: 0, combo: 0, score: 0 });
    expect(game.lastJudgement(0)).toBeNull();
  });

  it("duas notas na mesma pista a 100ms: cada toque julga uma", () => {
    const { game, advance, now, play, note } = setup();
    play();
    const t = now() + 0.5;
    note(t, 1);
    note(t + 0.1, 1);
    advance(0.5);
    game.onKeyDown(1, t);
    game.onKeyUp(1, t + 0.02);
    game.onKeyDown(1, t + 0.1);
    advance(0.5);
    expect(game.stats).toMatchObject({ perfect: 2, miss: 0, combo: 2 });
  });

  it("toque só julga a própria pista", () => {
    const { game, now, play, note } = setup();
    play();
    note(now(), 0);
    game.onKeyDown(1, now());
    expect(game.stats.perfect).toBe(0);
    expect(game.lastJudgement(1)).toBeNull();
  });

  it("tick: nota não julgada com gt − t > WINDOW_MISS_S vira MISS e zera o combo", () => {
    const { game, advance, now, play, note } = setup();
    play();
    note(now() + 0.1);
    advance(0.1);
    game.onKeyDown(0, now());
    expect(game.stats.combo).toBe(1);
    note(now() + 0.1);
    advance(0.1 + CONFIG.WINDOW_MISS_S - 0.01);
    expect(game.stats.miss).toBe(0);
    advance(0.02);
    expect(game.stats).toMatchObject({ miss: 1, combo: 0, maxCombo: 1 });
  });

  it("score e multiplicador: min(1 + floor(combo/10), 4)", () => {
    const { game, advance, now, play, note } = setup();
    play();
    const N = 45;
    for (let i = 0; i < N; i++) note(now() + 0.5 + i * 0.2, (i % 4) as Lane);
    let expected = 0;
    for (let i = 0; i < N; i++) {
      advance(i === 0 ? 0.5 : 0.2);
      game.onKeyDown((i % 4) as Lane, now());
      game.onKeyUp((i % 4) as Lane, now());
      const combo = i + 1;
      expected += CONFIG.SCORE_PERFECT * Math.min(1 + Math.floor(combo / 10), 4);
      if (combo === 9) expect(game.stats.multiplier).toBe(1);
      if (combo === 10) expect(game.stats.multiplier).toBe(2);
    }
    expect(game.stats.score).toBe(expected);
    expect(game.stats.multiplier).toBe(4);
    expect(game.stats.maxCombo).toBe(N);
  });

  it("GOOD vale SCORE_GOOD; não julga fora de PLAYING", () => {
    const { game, advance, now, play, note } = setup();
    play();
    const t = now() + 0.5;
    note(t);
    advance(0.5);
    game.onKeyDown(0, t + 0.06);
    expect(game.stats.score).toBe(CONFIG.SCORE_GOOD);
    note(now() + 0.5);
    game.pause();
    game.onKeyDown(0, now() + 0.5);
    expect(game.stats.good + game.stats.perfect).toBe(1);
  });
});

describe("notas", () => {
  it("visibleNotes: ordenadas por t, inclui caudas que cruzam a janela, é uma view reaproveitada", () => {
    const { game, now, play, note } = setup();
    play();
    const t = now();
    const a = note(t + 0.1, 0);
    note(t + 0.5, 1);
    note(t + 2, 2);
    game.onAnalyzerMsg({ type: "sustain-extend", id: a, until: t + 1 });
    const v1 = game.visibleNotes(t + 0.3, t + 1);
    expect(v1.map((n) => n.lane)).toEqual([0, 1]);
    const v2 = game.visibleNotes(t + 1.5, t + 2.5);
    expect(v2).toBe(v1);
    expect(v2.map((n) => n.lane)).toEqual([2]);
  });

  it("sustain-extend cresce sustainUntil; sustain-end fixa sustainEnd = sustainUntil", () => {
    const { game, now, play, note } = setup();
    play();
    const id = note(now() + 1);
    game.onAnalyzerMsg({ type: "sustain-extend", id, until: now() + 1.4 });
    game.onAnalyzerMsg({ type: "sustain-extend", id, until: now() + 1.6 });
    const [n] = game.visibleNotes(-Infinity, Infinity);
    expect(n!.sustainUntil).toBeCloseTo(now() + 1.6);
    game.onAnalyzerMsg({ type: "sustain-end", id, end: now() + 1.7 });
    expect(n!.sustainEnd).toBeCloseTo(now() + 1.7);
    expect(n!.sustainUntil).toBe(n!.sustainEnd);
    // Mensagem para nota desconhecida é ignorada.
    game.onAnalyzerMsg({ type: "sustain-end", id: 999, end: 0 });
  });

  it("nota julgada sai da memória 1s depois de terminar", () => {
    const { game, advance, now, play, note } = setup();
    play();
    const t = now() + 0.1;
    note(t);
    advance(0.1);
    game.onKeyDown(0, now());
    advance(0.95);
    expect(game.visibleNotes(-Infinity, Infinity)).toHaveLength(1);
    advance(0.1);
    expect(game.visibleNotes(-Infinity, Infinity)).toHaveLength(0);
  });
});

describe("sustain", () => {
  /** Nota em t com sustain de `len` segundos já encerrado pelo analisador. */
  function sustainNote(s: ReturnType<typeof setup>, len: number) {
    const t = s.now() + 0.5;
    const id = s.note(t, 3);
    s.game.onAnalyzerMsg({ type: "sustain-extend", id, until: t + CONFIG.SUSTAIN_MIN_S });
    s.game.onAnalyzerMsg({ type: "sustain-extend", id, until: t + len - 0.05 });
    s.game.onAnalyzerMsg({ type: "sustain-end", id, end: t + len });
    s.advance(0.5);
    const n = s.game.visibleNotes(-Infinity, Infinity).find((x) => x.id === id)!;
    return { t, n };
  }

  it("sustain de 1s segurado inteiro: ticksAwarded = 10 (± 1)", () => {
    const s = setup();
    s.play();
    const { n } = sustainNote(s, 1);
    s.game.onKeyDown(3, s.now());
    expect(n.holding).toBe(true);
    s.advance(1.2);
    s.game.onKeyUp(3, s.now());
    expect(n.ticksAwarded).toBeGreaterThanOrEqual(9);
    expect(n.ticksAwarded).toBeLessThanOrEqual(11);
    expect(n.holding).toBe(false);
    expect(s.game.stats.ticks).toBe(n.ticksAwarded);
    expect(s.game.stats.score).toBe(CONFIG.SCORE_PERFECT + n.ticksAwarded * CONFIG.SCORE_TICK);
  });

  it("soltar dentro da tolerância do fim conta como completo", () => {
    const s = setup();
    s.play();
    const { t, n } = sustainNote(s, 1);
    s.game.onKeyDown(3, s.now());
    s.advance(1 - CONFIG.SUSTAIN_RELEASE_TOLERANCE_S + 0.01);
    s.game.onKeyUp(3, s.now());
    expect(n.ticksAwarded).toBe(10);
    expect(s.now()).toBeLessThan(t + 1);
  });

  it("soltar cedo: ticks param e o combo não quebra", () => {
    const s = setup();
    s.play();
    const { n } = sustainNote(s, 1);
    s.game.onKeyDown(3, s.now());
    s.advance(0.45);
    s.game.onKeyUp(3, s.now());
    const ticks = n.ticksAwarded;
    expect(ticks).toBe(4);
    expect(n.holding).toBe(false);
    s.game.onKeyDown(3, s.now()); // apertar de novo não retoma
    s.advance(0.6);
    expect(n.ticksAwarded).toBe(ticks);
    expect(s.game.stats.combo).toBe(1);
    expect(s.game.stats.miss).toBe(0);
  });

  it("cabeça MISS não dá ticks", () => {
    const s = setup();
    s.play();
    const { n } = sustainNote(s, 1);
    s.advance(0.2); // passou da janela sem apertar
    s.game.onKeyDown(3, s.now());
    s.advance(1);
    expect(n.judged).toBe("MISS");
    expect(n.ticksAwarded).toBe(0);
    expect(n.holding).toBeFalsy();
  });

  it("ticks só avançam com a tecla pressionada e até sustainUntil enquanto não há fim", () => {
    const s = setup();
    s.play();
    const t = s.now() + 0.5;
    const id = s.note(t, 0);
    s.game.onAnalyzerMsg({ type: "sustain-extend", id, until: t + 0.4 });
    s.advance(0.5);
    s.game.onKeyDown(0, s.now());
    s.advance(1);
    const n = s.game.visibleNotes(-Infinity, Infinity).find((x) => x.id === id)!;
    expect(n.ticksAwarded).toBe(4);
    expect(n.holding).toBe(true); // ainda pode crescer
    s.game.onAnalyzerMsg({ type: "sustain-extend", id, until: t + 1.2 });
    s.advance(0.3);
    expect(n.ticksAwarded).toBe(12);
  });
});
