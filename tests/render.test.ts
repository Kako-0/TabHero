import { describe, expect, it } from "vitest";
import type { GameStats, Note } from "@/content/game/game";
import {
  computeLayout,
  createRenderer,
  FEEDBACK_S,
  type FrameSurface,
  LANE_COLORS,
  noteY,
  type RenderState,
} from "@/content/game/render";
import { CONFIG } from "@/shared/config";
import type { Lane } from "@/shared/types";

interface Call {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  globalAlpha: number;
}

/** Contexto 2D falso: grava as chamadas com o estado de estilo do momento. */
function fakeCtx(w = 1280, h = 720) {
  const calls: Call[] = [];
  const state = {
    fillStyle: "#000" as unknown,
    strokeStyle: "#000" as unknown,
    globalAlpha: 1,
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({
        op,
        args,
        fillStyle: state.fillStyle,
        strokeStyle: state.strokeStyle,
        globalAlpha: state.globalAlpha,
      });
    };
  let pendingRect: unknown[] | null = null;
  const ctx = Object.assign(state, {
    canvas: { width: w, height: h },
    createLinearGradient: () => ({ addColorStop() {}, tag: "gradient" }),
    fillRect: record("fillRect"),
    drawImage: record("drawImage"),
    strokeText: record("strokeText"),
    fillText: record("fillText"),
    beginPath() {
      pendingRect = null;
    },
    roundRect(...args: unknown[]) {
      pendingRect = args;
    },
    fill() {
      record("fillRoundRect")(...(pendingRect ?? []));
    },
    stroke() {
      record("strokeRoundRect")(...(pendingRect ?? []));
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function stats(p: Partial<GameStats> = {}): GameStats {
  return {
    score: 0,
    combo: 0,
    maxCombo: 0,
    multiplier: 1,
    perfect: 0,
    good: 0,
    miss: 0,
    ticks: 0,
    ...p,
  };
}

function state(p: Partial<RenderState> = {}): RenderState {
  return {
    now: 10,
    frame: null,
    notes: [],
    pressed: [false, false, false, false],
    feedback: () => null,
    stats: stats(),
    dim: CONFIG.VIDEO_DIM,
    ...p,
  };
}

const note = (p: Partial<Note> & { t: number }): Note => ({
  id: 1,
  lane: 0 as Lane,
  ticksAwarded: 0,
  ...p,
});

function fakeSurface() {
  const drawn: unknown[] = [];
  const make = (w: number, h: number): FrameSurface => ({
    width: w,
    height: h,
    getContext: () => ({
      drawImage: ((img: unknown) => drawn.push(img)) as CanvasRenderingContext2D["drawImage"],
      clearRect: () => {},
    }),
  });
  return { make, drawn };
}

const bitmap = (w = 640, h = 360) => ({ width: w, height: h }) as ImageBitmap;

describe("layout", () => {
  it("pista centralizada: min(40% da largura, 4 × 120px × escala); linha a 85%", () => {
    const wide = computeLayout(1920, 1080);
    expect(wide.hwW).toBeCloseTo(4 * 120 * 1.5);
    expect(wide.hwX).toBeCloseTo((1920 - wide.hwW) / 2);
    expect(wide.yHit).toBeCloseTo(0.85 * 1080);
    expect(wide.noteH).toBeCloseTo(18 * 1.5);

    const narrow = computeLayout(800, 1080);
    expect(narrow.hwW).toBeCloseTo(320);
    expect(narrow.laneW).toBeCloseTo(80);
    expect(narrow.tailW).toBeCloseTo(narrow.noteW * 0.4);
  });

  it("y(t): topo VISIBLE_LEAD_S antes, linha de acerto em t = now", () => {
    expect(noteY(10, 10, 612)).toBeCloseTo(612);
    expect(noteY(10 + CONFIG.VISIBLE_LEAD_S, 10, 612)).toBeCloseTo(0);
    expect(noteY(10 + CONFIG.VISIBLE_LEAD_S / 2, 10, 612)).toBeCloseTo(306);
  });
});

describe("renderFrame", () => {
  it("sem frame nunca: gradiente; com frame: cover; depois sem frame: mantém o último", () => {
    const { ctx, calls } = fakeCtx(1280, 720);
    const surf = fakeSurface();
    const r = createRenderer({ createSurface: surf.make });

    r.renderFrame(ctx, state());
    expect(calls[0]).toMatchObject({ op: "fillRect", args: [0, 0, 1280, 720] });
    expect(calls[0]!.fillStyle).toMatchObject({ tag: "gradient" });
    // escurecimento logo depois
    expect(calls[1]).toMatchObject({ op: "fillRect", globalAlpha: CONFIG.VIDEO_DIM });

    calls.length = 0;
    const f = bitmap(640, 360);
    r.renderFrame(ctx, state({ frame: f }));
    expect(surf.drawn).toEqual([f]);
    expect(calls[0]).toMatchObject({ op: "drawImage", args: [expect.anything(), 0, 0, 1280, 720] });

    calls.length = 0;
    r.renderFrame(ctx, state({ frame: null }));
    expect(calls[0]!.op).toBe("drawImage"); // último frame
    expect(surf.drawn).toHaveLength(1); // não recopia

    r.forgetFrame();
    calls.length = 0;
    r.renderFrame(ctx, state({ frame: null }));
    expect(calls[0]!.fillStyle).toMatchObject({ tag: "gradient" });
  });

  it("cover corta as sobras mantendo a proporção", () => {
    const { ctx, calls } = fakeCtx(1000, 1000);
    const r = createRenderer({ createSurface: fakeSurface().make });
    r.renderFrame(ctx, state({ frame: bitmap(640, 360) }));
    const [, x, y, w, h] = calls[0]!.args as [unknown, number, number, number, number];
    expect(h).toBeCloseTo(1000);
    expect(w).toBeCloseTo((640 * 1000) / 360);
    expect(x).toBeCloseTo((1000 - w) / 2);
    expect(y).toBeCloseTo(0);
  });

  it("dim de PAUSED/SYNCING", () => {
    const { ctx, calls } = fakeCtx();
    createRenderer().renderFrame(ctx, state({ dim: 0.7 }));
    expect(calls[1]).toMatchObject({ op: "fillRect", globalAlpha: 0.7 });
  });

  it("alvo preenchido só com a tecla pressionada; letras D F J K", () => {
    const { ctx, calls } = fakeCtx();
    createRenderer().renderFrame(ctx, state({ pressed: [false, true, false, false] }));
    const fills = calls.filter((c) => c.op === "fillRoundRect");
    expect(fills).toHaveLength(1);
    expect(fills[0]!.fillStyle).toBe(LANE_COLORS[1]);
    expect(calls.filter((c) => c.op === "strokeRoundRect")).toHaveLength(4);
    const letters = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(letters).toEqual(expect.arrayContaining(["D", "F", "J", "K"]));
  });

  it("nota: cabeça na posição y(t); PERFECT/GOOD somem; MISS fica cinza", () => {
    const { ctx, calls } = fakeCtx(1280, 720);
    const L = computeLayout(1280, 720);
    const now = 10;
    const notes = [
      note({ id: 1, t: now + 0.5, lane: 2 }),
      note({ id: 2, t: now - 0.05, lane: 0, judged: "PERFECT" }),
      note({ id: 3, t: now - 0.1, lane: 1, judged: "MISS" }),
    ];
    createRenderer().renderFrame(ctx, state({ now, notes }));
    const heads = calls.filter((c) => c.op === "fillRoundRect");
    expect(heads).toHaveLength(2);
    const [x, y, w, h] = heads.find((c) => c.fillStyle === LANE_COLORS[2])!.args as [
      number,
      number,
      number,
      number,
    ];
    expect(y + h / 2).toBeCloseTo(noteY(now + 0.5, now, L.yHit));
    expect(x + w / 2).toBeCloseTo(L.hwX + 2.5 * L.laneW);
    expect(heads.some((c) => c.fillStyle === "#6b7280")).toBe(true);
  });

  it("sustain: cauda até sustainUntil limitada ao topo; trecho pontuado mais brilhante", () => {
    const { ctx, calls } = fakeCtx(1280, 720);
    const L = computeLayout(1280, 720);
    const now = 10;
    const n = note({
      t: now - 0.3,
      lane: 3,
      sustainUntil: now + 5,
      judged: "PERFECT",
      holding: true,
      ticksAwarded: 2,
    });
    createRenderer().renderFrame(ctx, state({ now, notes: [n] }));
    const cx = L.hwX + 3.5 * L.laneW;
    const tail = calls.filter((c) => c.op === "fillRect" && c.args[0] === cx - L.tailW / 2);
    const yHead = Math.min(720, noteY(n.t, now, L.yHit)); // limitada à borda de baixo
    // cauda completa (do topo até a cabeça), trecho pontuado e brilho branco
    expect(tail[0]!.args).toEqual([cx - L.tailW / 2, 0, L.tailW, yHead]);
    const yScored = noteY(n.t + 2 * CONFIG.SUSTAIN_TICK_S, now, L.yHit);
    expect(tail[1]).toMatchObject({ globalAlpha: 1 });
    expect(tail[1]!.args[1]).toBeCloseTo(yScored);
    expect(tail[2]!.fillStyle).toBe("#fff");
    // cabeça julgada some
    expect(calls.some((c) => c.op === "fillRoundRect")).toBe(false);
  });

  it("feedback: texto por FEEDBACK_S com fade; nada com movimento reduzido", () => {
    const fb = (at: number) => (lane: Lane) => (lane === 0 ? { j: "GOOD" as const, at } : null);
    const texts = (calls: Call[]) =>
      calls.filter((c) => c.op === "fillText" && c.args[0] === "GOOD");

    let f = fakeCtx();
    createRenderer().renderFrame(f.ctx, state({ now: 10, feedback: fb(10 - FEEDBACK_S / 2) }));
    expect(texts(f.calls)).toHaveLength(1);
    expect(texts(f.calls)[0]!.globalAlpha).toBeCloseTo(0.5);

    f = fakeCtx();
    createRenderer().renderFrame(f.ctx, state({ now: 10, feedback: fb(10 - FEEDBACK_S) }));
    expect(texts(f.calls)).toHaveLength(0);

    f = fakeCtx();
    createRenderer({ reducedMotion: () => true }).renderFrame(
      f.ctx,
      state({ now: 10, feedback: fb(9.9) }),
    );
    expect(texts(f.calls)).toHaveLength(0);
    // só a cor do alvo muda
    const strokes = f.calls.filter((c) => c.op === "strokeRoundRect");
    expect(strokes[0]!.strokeStyle).toBe("#ffffff");
  });

  it("HUD: score sempre; combo e multiplicador só com combo ≥ 5", () => {
    let f = fakeCtx();
    const r = createRenderer();
    r.renderFrame(f.ctx, state({ stats: stats({ score: 1234, combo: 4 }) }));
    const t1 = f.calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(t1).toContain((1234).toLocaleString("pt-BR"));
    expect(t1.some((t) => String(t).includes("combo"))).toBe(false);

    f = fakeCtx();
    r.renderFrame(f.ctx, state({ stats: stats({ score: 1234, combo: 12, multiplier: 2 }) }));
    const t2 = f.calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(t2.some((t) => t.includes("12 combo") && t.includes("×2"))).toBe(true);
  });

  it("canvas de tamanho 0 (overlay ainda sem layout): não desenha", () => {
    const { ctx, calls } = fakeCtx(0, 0);
    createRenderer().renderFrame(ctx, state());
    expect(calls).toHaveLength(0);
  });
});
