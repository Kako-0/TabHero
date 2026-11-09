// Spec 05: máquina de estados da partida, notas, julgamento, sustain e score.
// Puro: não conhece o DOM nem o grafo. Os efeitos de cada transição saem por `GameEffects`
// (implementados em ../gameEffects.ts, chamados por main.tsx).
import { CONFIG } from "@/shared/config";
import type { AnalyzerMsg, Lane } from "@/shared/types";

export type GameState =
  "IDLE" | "COUNTDOWN" | "PLAYING" | "PAUSED" | "RESUMING" | "SYNCING" | "AD" | "RESULTS" | "ERROR";

export type Judgement = "PERFECT" | "GOOD" | "MISS";

export interface Note {
  id: number;
  t: number;
  lane: Lane;
  sustainUntil?: number; // cresce com sustain-extend
  sustainEnd?: number; // definido em sustain-end
  judged?: Judgement;
  holding?: boolean;
  ticksAwarded: number;
}

export interface GameStats {
  score: number;
  combo: number;
  maxCombo: number;
  multiplier: number;
  perfect: number;
  good: number;
  miss: number;
  ticks: number;
}

export type PauseReason = "user" | "buffering";

/** Ações das transições (tabela da spec 05). Todas opcionais nos testes. */
export interface GameEffects {
  /** IDLE/RESULTS → COUNTDOWN: modo game, vídeo em 0 e pausado, captura de vídeo ligada. */
  enterGame(): void;
  /** Em VIDEO_PLAY_AT_COUNTDOWN_S da contagem: video.play() + clock.resync(). */
  startPlayback(): void;
  /** → PAUSED: video.pause() + graph.suspend(). */
  pause(reason: PauseReason): void;
  /** PAUSED → PLAYING: graph.resume() + video.play() + clock.resync(). */
  resume(): void;
  /** → SYNCING: graph.flush() (reset do analisador) + videoDelay.clear(). */
  flush(): void;
  /** AD: análise inativa (`set-active:false`); de volta a true no adEnded. */
  setAnalysisActive(active: boolean): void;
  /** → IDLE: graph.dispose(), videoDelay.stop(), restaura o <video>, remove o overlay. */
  teardown(): void;
}

export interface Game {
  readonly state: GameState;
  readonly stats: GameStats;
  /** Motivo do PAUSED (buffering = pause automático, sem menu). */
  readonly pauseReason: PauseReason | null;
  /** Segundos que faltam na contagem (só em COUNTDOWN e RESUMING). */
  readonly countdown: number | null;
  readonly errorCode: string | null;
  /**
   * Notas com t ≤ to cuja extensão (cabeça ou cauda) alcança `from`, ordenadas por t.
   * Devolve uma view reaproveitada entre chamadas (sem alocação por frame): não guardar.
   */
  visibleNotes(from: number, to: number): readonly Note[];
  lastJudgement(lane: Lane): { j: Judgement; at: number } | null;
  isPressed(lane: Lane): boolean;

  // entradas
  onAnalyzerMsg(m: AnalyzerMsg): void;
  onKeyDown(lane: Lane, gameTime: number): void;
  onKeyUp(lane: Lane, gameTime: number): void;
  /**
   * A cada rAF. `wallTime` (s, relógio de parede, ex.: performance.now()/1000) mede a
   * contagem do RESUMING, em que o gameTime está congelado (ctx suspensa). Padrão: gameTime.
   */
  tick(gameTime: number, wallTime?: number): void;

  // eventos do player/controle (vêm de main.tsx)
  start(): void;
  /** PLAYING → PAUSED; em RESUMING, cancela a contagem e volta a PAUSED. */
  pause(reason?: PauseReason): void;
  /** PAUSED → RESUMING (contagem) → PLAYING; pause por buffering volta direto a PLAYING. */
  resume(): void;
  seeked(): void;
  adStarted(): void;
  adEnded(): void;
  /** `endAt`: procTime em que a mídia terminou (ctx.currentTime); padrão: último gameTime + DELAY_S. */
  ended(endAt?: number): void;
  exit(): void;
  fail(code: string): void;

  on(ev: "state", fn: (s: GameState) => void): void;
}

export type GameConfig = Pick<
  typeof CONFIG,
  | "DELAY_S"
  | "COUNTDOWN_S"
  | "RESUME_COUNTDOWN_S"
  | "VIDEO_PLAY_AT_COUNTDOWN_S"
  | "SYNC_AFTER_SEEK_S"
  | "LANES"
  | "WINDOW_PERFECT_S"
  | "WINDOW_GOOD_S"
  | "WINDOW_MISS_S"
  | "SUSTAIN_TICK_S"
  | "SUSTAIN_RELEASE_TOLERANCE_S"
  | "SCORE_PERFECT"
  | "SCORE_GOOD"
  | "SCORE_TICK"
  | "COMBO_STEP"
  | "MAX_MULTIPLIER"
>;

/** Folga de ponto flutuante nas janelas (t ± 45ms exatos é PERFECT). */
const EPS = 1e-6;
/** Notas julgadas saem da memória quando terminam antes de gameTime − isso. */
const KEEP_AFTER_S = 1;

const noop = () => {};
const NO_EFFECTS: GameEffects = {
  enterGame: noop,
  startPlayback: noop,
  pause: noop,
  resume: noop,
  flush: noop,
  setAnalysisActive: noop,
  teardown: noop,
};

function emptyStats(): GameStats {
  return { score: 0, combo: 0, maxCombo: 0, multiplier: 1, perfect: 0, good: 0, miss: 0, ticks: 0 };
}

/** Fim da nota para remoção/visibilidade: sustainEnd, senão sustainUntil, senão t. */
function noteEnd(n: Note): number {
  return n.sustainEnd ?? n.sustainUntil ?? n.t;
}

export function createGame(effects: Partial<GameEffects> = {}, cfg: GameConfig = CONFIG): Game {
  const fx: GameEffects = { ...NO_EFFECTS, ...effects };
  const listeners: ((s: GameState) => void)[] = [];

  let state: GameState = "IDLE";
  let stats = emptyStats();
  let notes: Note[] = [];
  const byId = new Map<number, Note>();
  const view: Note[] = [];
  const pressed: boolean[] = new Array<boolean>(cfg.LANES).fill(false);
  const feedback: ({ j: Judgement; at: number } | null)[] = new Array(cfg.LANES).fill(null);

  let lastGt: number | null = null;
  let pauseReason: PauseReason | null = null;
  let errorCode: string | null = null;
  /** gameTime do 1º tick no estado temporizado atual (COUNTDOWN/SYNCING). */
  let phaseStart: number | null = null;
  let countdownLeft: number | null = null;
  /** wallTime do 1º tick em RESUMING. */
  let resumeStart: number | null = null;
  let playbackStarted = false;
  /** procTime a partir do qual o jogo vai para RESULTS (definido em `ended`). */
  let endAt: number | null = null;
  /** Após um flush, ignora mensagens do analisador até o `reset-ack` (podem ser de antes). */
  let awaitingAck = false;

  function setState(s: GameState): void {
    if (s === state) return;
    state = s;
    for (const fn of listeners) fn(s);
  }

  function clearNotes(): void {
    notes = [];
    byId.clear();
    view.length = 0;
  }

  function resetMatch(): void {
    stats = emptyStats();
    clearNotes();
    feedback.fill(null);
    phaseStart = null;
    countdownLeft = cfg.COUNTDOWN_S;
    playbackStarted = false;
    endAt = null;
    awaitingAck = false;
    pauseReason = null;
    errorCode = null;
  }

  function setCombo(c: number): void {
    stats.combo = c;
    stats.maxCombo = Math.max(stats.maxCombo, c);
    stats.multiplier = Math.min(1 + Math.floor(c / cfg.COMBO_STEP), cfg.MAX_MULTIPLIER);
  }

  function judge(n: Note, j: Judgement, at: number): void {
    n.judged = j;
    feedback[n.lane] = { j, at };
    if (j === "MISS") {
      stats.miss++;
      setCombo(0);
      return;
    }
    if (j === "PERFECT") stats.perfect++;
    else stats.good++;
    setCombo(stats.combo + 1);
    stats.score += (j === "PERFECT" ? cfg.SCORE_PERFECT : cfg.SCORE_GOOD) * stats.multiplier;
    n.holding = n.sustainUntil !== undefined;
  }

  /** Ticks de sustain decorridos entre t e min(upTo, sustainUntil). */
  function awardTicks(n: Note, upTo: number): void {
    if (n.sustainUntil === undefined) return;
    const elapsed = Math.min(upTo, n.sustainUntil) - n.t;
    const target = Math.floor(elapsed / cfg.SUSTAIN_TICK_S + EPS);
    while (n.ticksAwarded < target) {
      n.ticksAwarded++;
      stats.ticks++;
      stats.score += cfg.SCORE_TICK * stats.multiplier;
    }
  }

  function enterSyncing(): void {
    fx.flush();
    clearNotes();
    awaitingAck = true;
    phaseStart = null;
    setState("SYNCING");
  }

  function goResults(): void {
    // Notas que ainda não chegaram à linha não serão mais tocadas: contam como MISS.
    for (const n of notes) {
      if (!n.judged) judge(n, "MISS", lastGt ?? n.t);
      n.holding = false;
    }
    endAt = null;
    setState("RESULTS");
  }

  function tickPlaying(gt: number): void {
    for (const n of notes) {
      if (!n.judged) {
        if (gt - n.t > cfg.WINDOW_MISS_S + EPS) judge(n, "MISS", gt);
        continue;
      }
      if (!n.holding) continue;
      if (pressed[n.lane]) awardTicks(n, gt);
      if (n.sustainEnd !== undefined && gt >= n.sustainEnd) n.holding = false;
    }
    // Remoção das notas já julgadas que terminaram há mais de 1s.
    const cutoff = gt - KEEP_AFTER_S;
    if (notes.length > 0 && notes.some((n) => n.judged && noteEnd(n) < cutoff)) {
      notes = notes.filter((n) => {
        const drop = n.judged !== undefined && noteEnd(n) < cutoff;
        if (drop) byId.delete(n.id);
        return !drop;
      });
    }
  }

  return {
    get state() {
      return state;
    },
    get stats() {
      return stats;
    },
    get pauseReason() {
      return pauseReason;
    },
    get countdown() {
      return state === "COUNTDOWN" || state === "RESUMING" ? countdownLeft : null;
    },
    get errorCode() {
      return errorCode;
    },

    visibleNotes(from, to) {
      view.length = 0;
      for (const n of notes) {
        if (n.t > to) break;
        if (noteEnd(n) >= from) view.push(n);
      }
      return view;
    },

    lastJudgement(lane) {
      return feedback[lane] ?? null;
    },

    isPressed(lane) {
      return pressed[lane] ?? false;
    },

    onAnalyzerMsg(m) {
      if (m.type === "reset-ack") {
        awaitingAck = false;
        return;
      }
      if (awaitingAck) return;
      if (state === "IDLE" || state === "RESULTS" || state === "ERROR" || state === "AD") return;
      switch (m.type) {
        case "note": {
          const n: Note = { id: m.id, t: m.t, lane: m.lane, ticksAwarded: 0 };
          // Chegam em ordem; por segurança, insere ordenado se vier fora.
          let i = notes.length;
          while (i > 0 && notes[i - 1]!.t > n.t) i--;
          notes.splice(i, 0, n);
          byId.set(n.id, n);
          break;
        }
        case "sustain-extend": {
          const n = byId.get(m.id);
          if (n && n.sustainEnd === undefined)
            n.sustainUntil = Math.max(n.sustainUntil ?? n.t, m.until);
          break;
        }
        case "sustain-end": {
          const n = byId.get(m.id);
          if (n) {
            n.sustainEnd = m.end;
            n.sustainUntil = m.end;
          }
          break;
        }
      }
    },

    onKeyDown(lane, gt) {
      pressed[lane] = true;
      if (state !== "PLAYING") return;
      for (const n of notes) {
        if (n.lane !== lane || n.judged) continue;
        const d = Math.abs(n.t - gt);
        if (d > cfg.WINDOW_MISS_S + EPS) {
          if (n.t > gt) break; // ordenadas por t: as próximas estão mais longe
          continue;
        }
        const j: Judgement =
          d <= cfg.WINDOW_PERFECT_S + EPS
            ? "PERFECT"
            : d <= cfg.WINDOW_GOOD_S + EPS
              ? "GOOD"
              : "MISS";
        judge(n, j, gt);
        return;
      }
      // Sem nota na janela: ghost press, sem penalidade.
    },

    onKeyUp(lane, gt) {
      pressed[lane] = false;
      if (state !== "PLAYING") return;
      for (const n of notes) {
        if (n.lane !== lane || !n.holding || n.sustainUntil === undefined) continue;
        awardTicks(n, gt);
        // Soltou dentro da tolerância do fim (já conhecido): conta como sustain completo.
        if (n.sustainEnd !== undefined && gt >= n.sustainEnd - cfg.SUSTAIN_RELEASE_TOLERANCE_S) {
          awardTicks(n, n.sustainEnd);
        }
        // Solto cedo: os ticks param; o combo não quebra.
        n.holding = false;
      }
    },

    tick(gt, wall = gt) {
      lastGt = gt;
      switch (state) {
        case "RESUMING": {
          resumeStart ??= wall;
          const elapsed = wall - resumeStart;
          countdownLeft = Math.max(0, cfg.RESUME_COUNTDOWN_S - elapsed);
          if (elapsed >= cfg.RESUME_COUNTDOWN_S) {
            resumeStart = null;
            pauseReason = null;
            fx.resume();
            setState("PLAYING");
          }
          break;
        }
        case "COUNTDOWN": {
          phaseStart ??= gt;
          const elapsed = gt - phaseStart;
          if (!playbackStarted && elapsed >= cfg.VIDEO_PLAY_AT_COUNTDOWN_S) {
            playbackStarted = true;
            fx.startPlayback();
          }
          countdownLeft = Math.max(0, cfg.COUNTDOWN_S - elapsed);
          if (elapsed >= cfg.COUNTDOWN_S) {
            phaseStart = null;
            setState("PLAYING");
            tickPlaying(gt);
          }
          break;
        }
        case "SYNCING": {
          phaseStart ??= gt;
          if (gt - phaseStart >= cfg.SYNC_AFTER_SEEK_S) {
            phaseStart = null;
            setState("PLAYING");
            tickPlaying(gt);
          }
          break;
        }
        case "PLAYING":
          tickPlaying(gt);
          break;
      }
      if ((state === "PLAYING" || state === "SYNCING") && endAt !== null && gt >= endAt)
        goResults();
    },

    start() {
      if (state !== "IDLE" && state !== "RESULTS") return;
      resetMatch();
      fx.enterGame();
      setState("COUNTDOWN");
    },

    pause(reason = "user") {
      if (state === "RESUMING") {
        // Vídeo e grafo ainda estão parados: só cancela a contagem.
        resumeStart = null;
        countdownLeft = null;
        setState("PAUSED");
        return;
      }
      if (state !== "PLAYING") return;
      pauseReason = reason;
      // Teclas soltas durante o pause (blur, menu) não geram keyup: começa limpo.
      pressed.fill(false);
      for (const n of notes) n.holding = false;
      fx.pause(reason);
      setState("PAUSED");
    },

    resume() {
      if (state !== "PAUSED") return;
      if (pauseReason === "buffering") {
        // Automático (o <video> já voltou a tocar): sem contagem.
        pauseReason = null;
        fx.resume();
        setState("PLAYING");
        return;
      }
      // Contagem com tudo parado; o fx.resume() sai no fim dela (tick).
      resumeStart = null;
      countdownLeft = cfg.RESUME_COUNTDOWN_S;
      setState("RESUMING");
    },

    seeked() {
      if (state !== "PLAYING" && state !== "SYNCING") return;
      setCombo(0);
      endAt = null;
      enterSyncing();
    },

    adStarted() {
      if (state !== "PLAYING" && state !== "SYNCING" && state !== "COUNTDOWN") return;
      fx.setAnalysisActive(false);
      // O fim da música no buffer toca durante o anúncio, sem jogo: não vira MISS.
      clearNotes();
      phaseStart = null;
      setState("AD");
    },

    adEnded() {
      if (state !== "AD") return;
      playbackStarted = true;
      fx.setAnalysisActive(true);
      // O buffer tem o áudio/vídeo do anúncio: descarta e ressincroniza.
      enterSyncing();
    },

    ended(at) {
      if (state !== "PLAYING" && state !== "SYNCING" && state !== "PAUSED" && state !== "RESUMING")
        return;
      endAt = at ?? (lastGt ?? 0) + cfg.DELAY_S;
    },

    exit() {
      if (state === "IDLE") return;
      fx.teardown();
      errorCode = null;
      clearNotes();
      pressed.fill(false);
      pauseReason = null;
      endAt = null;
      setState("IDLE");
    },

    fail(code) {
      errorCode = code;
      for (const n of notes) n.holding = false;
      endAt = null;
      setState("ERROR");
    },

    on(_ev, fn) {
      listeners.push(fn);
    },
  };
}
