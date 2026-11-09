// Spec 07: render do jogo em Canvas 2D, a cada rAF. Coordenadas em pixels do canvas
// (tamanho CSS × devicePixelRatio). Sem alocação no caminho quente: layout, fontes e
// gradiente só são recalculados quando o tamanho muda; textos do HUD só quando o valor muda.
import { CONFIG } from "@/shared/config";
import { STRINGS } from "@/shared/strings";
import type { Lane } from "@/shared/types";
import type { GameStats, Judgement, Note } from "./game";

/** Cores das pistas D F J K (contraste com vídeo claro e escuro). */
export const LANE_COLORS = ["#22c55e", "#ef4444", "#eab308", "#3b82f6"] as const;
const KEY_LABELS = ["D", "F", "J", "K"] as const;
const MISS_COLOR = "#6b7280";
const JUDGE_COLORS: Record<Judgement, string> = {
  PERFECT: "#fde047",
  GOOD: "#ffffff",
  MISS: "#9ca3af",
};
/** Duração do texto de julgamento (com fade). */
export const FEEDBACK_S = 0.3;
/** Altura de referência: escala 1 numa área de jogo de 720px. */
const REF_H = 720;
const HIT_Y = 0.85;
const COMBO_MIN = 5;
/**
 * Quanto do passado o render pede ao jogo: o bastante para a cabeça sair pela borda de
 * baixo (0,15 da altura abaixo da linha = 0,22s com VISIBLE_LEAD_S = 1,25).
 */
export const NOTES_BEHIND_S = ((1 - HIT_Y) / HIT_Y) * CONFIG.VISIBLE_LEAD_S + 0.03;

export interface Feedback {
  j: Judgement;
  at: number;
}

export interface RenderState {
  /** clock.gameTime() */
  now: number;
  /** videoDelay.frameAt(now); null: mantém o último desenhado (ou o gradiente, se nunca houve). */
  frame: ImageBitmap | null;
  /** game.visibleNotes(now − NOTES_BEHIND_S, now + VISIBLE_LEAD_S) */
  notes: readonly Note[];
  /** Teclas pressionadas, uma por pista. */
  pressed: readonly boolean[];
  feedback: (lane: Lane) => Feedback | null;
  stats: GameStats;
  /** Alpha do escurecimento: VIDEO_DIM, ou 0,7 em PAUSED/SYNCING. */
  dim: number;
}

export interface Layout {
  w: number;
  h: number;
  /** Escala do HUD (altura / 720). */
  scale: number;
  /** Escala da pista: ≤ scale quando a largura limita a pista a 40% da tela. */
  u: number;
  hwX: number;
  hwW: number;
  laneW: number;
  yHit: number;
  noteW: number;
  noteH: number;
  tailW: number;
}

export function computeLayout(w: number, h: number, out: Partial<Layout> = {}): Layout {
  const scale = h / REF_H;
  const hwW = Math.min(0.4 * w, CONFIG.LANES * 120 * scale);
  const laneW = hwW / CONFIG.LANES;
  const u = laneW / 120;
  const noteW = laneW * 0.8;
  out.w = w;
  out.h = h;
  out.scale = scale;
  out.u = u;
  out.hwX = (w - hwW) / 2;
  out.hwW = hwW;
  out.laneW = laneW;
  out.yHit = h * HIT_Y;
  out.noteW = noteW;
  out.noteH = 18 * u;
  out.tailW = noteW * 0.4;
  return out as Layout;
}

/** y da nota de tempo t: no topo VISIBLE_LEAD_S antes, na linha de acerto em t = now. */
export function noteY(t: number, now: number, yHit: number): number {
  return yHit - ((t - now) / CONFIG.VISIBLE_LEAD_S) * yHit;
}

/** Superfície onde o último frame é copiado (os bitmaps são fechados no seek/flush). */
export interface FrameSurface {
  width: number;
  height: number;
  getContext(id: "2d"): Pick<CanvasRenderingContext2D, "drawImage" | "clearRect"> | null;
}

export interface RendererOptions {
  /** prefers-reduced-motion: sem texto de feedback, só a cor do alvo muda. */
  reducedMotion?: () => boolean;
  createSurface?: (w: number, h: number) => FrameSurface;
}

export interface Renderer {
  renderFrame(ctx: CanvasRenderingContext2D, s: RenderState): void;
  /** Esquece o último frame (DRM: os frames são pretos); volta ao gradiente. */
  forgetFrame(): void;
}

function defaultSurface(w: number, h: number): FrameSurface {
  return new OffscreenCanvas(w, h) as unknown as FrameSurface;
}

export function createRenderer(opts: RendererOptions = {}): Renderer {
  const reducedMotion = opts.reducedMotion ?? (() => false);
  const createSurface = opts.createSurface ?? defaultSurface;

  const L = computeLayout(1, 1);
  let gradient: CanvasGradient | null = null;
  let fontKey = "";
  let fontScore = "";
  let fontCombo = "";
  let fontJudge = "";

  let surface: FrameSurface | null = null;
  let lastFrame: ImageBitmap | null = null;
  let hasFrame = false;

  let scoreValue = -1;
  let scoreText = "";
  let comboValue = -1;
  let comboMult = -1;
  let comboText = "";

  function relayout(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    computeLayout(w, h, L);
    gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#1f2937");
    gradient.addColorStop(1, "#030712");
    const px = (n: number) => `${Math.max(1, Math.round(n))}px`;
    const family = "system-ui, sans-serif";
    fontKey = `700 ${px(15 * L.u)} ${family}`;
    fontJudge = `800 ${px(20 * L.u)} ${family}`;
    fontCombo = `800 ${px(26 * L.u)} ${family}`;
    fontScore = `800 ${px(30 * L.scale)} ${family}`;
  }

  function copyFrame(frame: ImageBitmap): void {
    if (!surface || surface.width !== frame.width || surface.height !== frame.height) {
      surface = createSurface(frame.width, frame.height);
    }
    const sctx = surface.getContext("2d");
    if (!sctx) return;
    sctx.drawImage(frame, 0, 0);
    hasFrame = true;
  }

  function drawBackground(ctx: CanvasRenderingContext2D, s: RenderState): void {
    if (s.frame && s.frame !== lastFrame) {
      lastFrame = s.frame;
      copyFrame(s.frame);
    }
    const { w, h } = L;
    if (hasFrame && surface) {
      // cover: mantém a proporção e corta as sobras
      const sc = Math.max(w / surface.width, h / surface.height);
      const fw = surface.width * sc;
      const fh = surface.height * sc;
      ctx.drawImage(surface as unknown as CanvasImageSource, (w - fw) / 2, (h - fh) / 2, fw, fh);
    } else {
      ctx.fillStyle = gradient ?? "#111";
      ctx.fillRect(0, 0, w, h);
    }
    if (s.dim > 0) {
      ctx.globalAlpha = s.dim;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  }

  function drawHighway(ctx: CanvasRenderingContext2D): void {
    const { h, hwX, hwW, laneW, u } = L;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#000";
    ctx.fillRect(hwX, 0, hwW, h);
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = "#fff";
    const lw = Math.max(1, 2 * u);
    for (let i = 1; i < CONFIG.LANES; i++) ctx.fillRect(hwX + i * laneW - lw / 2, 0, lw, h);
    // linha de acerto
    ctx.globalAlpha = 0.6;
    ctx.fillRect(hwX, L.yHit - lw / 2, hwW, lw);
    ctx.globalAlpha = 1;
  }

  function laneCenter(lane: number): number {
    return L.hwX + (lane + 0.5) * L.laneW;
  }

  function drawTargets(ctx: CanvasRenderingContext2D, s: RenderState, rm: boolean): void {
    const { yHit, noteW, noteH, u } = L;
    const th = noteH + 10 * u;
    const r = th / 3;
    ctx.lineWidth = Math.max(1, 3 * u);
    ctx.font = fontKey;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let lane = 0; lane < CONFIG.LANES; lane++) {
      const cx = laneCenter(lane);
      const color = LANE_COLORS[lane]!;
      const pressed = s.pressed[lane] === true;
      let stroke: string = color;
      if (rm) {
        // Movimento reduzido: o julgamento aparece só como a cor do contorno do alvo.
        const fb = s.feedback(lane as Lane);
        if (fb && s.now >= fb.at && s.now - fb.at < FEEDBACK_S) stroke = JUDGE_COLORS[fb.j];
      }
      ctx.beginPath();
      ctx.roundRect(cx - noteW / 2, yHit - th / 2, noteW, th, r);
      if (pressed) {
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.strokeStyle = stroke;
      ctx.stroke();
      ctx.fillStyle = pressed ? "#000" : "#fff";
      ctx.fillText(KEY_LABELS[lane]!, cx, yHit);
    }
  }

  function drawNotes(ctx: CanvasRenderingContext2D, s: RenderState): void {
    const { h, yHit, noteW, noteH, tailW } = L;
    const r = noteH / 3;
    for (let i = 0; i < s.notes.length; i++) {
      const n = s.notes[i]!;
      const cx = laneCenter(n.lane);
      const miss = n.judged === "MISS";
      const hit = n.judged !== undefined && !miss;
      const color = miss ? MISS_COLOR : LANE_COLORS[n.lane];
      const yHead = noteY(n.t, s.now, yHit);

      if (n.sustainUntil !== undefined && n.sustainUntil > n.t) {
        const yEnd = Math.max(0, noteY(n.sustainUntil, s.now, yHit));
        const yStart = Math.min(h, yHead);
        if (yStart > yEnd) {
          // Solta antes do fim: a cauda que resta fica apagada.
          ctx.globalAlpha = hit && !n.holding ? 0.3 : 0.7;
          ctx.fillStyle = color;
          ctx.fillRect(cx - tailW / 2, yEnd, tailW, yStart - yEnd);
          if (n.holding) {
            // Trecho já pontuado (ticks): mais brilhante.
            const tScored = Math.min(n.t + n.ticksAwarded * CONFIG.SUSTAIN_TICK_S, n.sustainUntil);
            const yScored = Math.max(yEnd, noteY(tScored, s.now, yHit));
            if (yStart > yScored) {
              ctx.globalAlpha = 1;
              ctx.fillRect(cx - tailW / 2, yScored, tailW, yStart - yScored);
              ctx.globalAlpha = 0.45;
              ctx.fillStyle = "#fff";
              ctx.fillRect(cx - tailW / 2, yScored, tailW, yStart - yScored);
            }
          }
          ctx.globalAlpha = 1;
        }
      }

      // PERFECT/GOOD: a cabeça some.
      if (hit || yHead < -noteH || yHead > h + noteH) continue;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(cx - noteW / 2, yHead - noteH / 2, noteW, noteH, r);
      ctx.fill();
    }
  }

  /** Texto com contorno escuro (legível sobre vídeo claro). */
  function outlinedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    fill: string,
    lineWidth: number,
  ): void {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = "#000";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function drawFeedback(ctx: CanvasRenderingContext2D, s: RenderState): void {
    const { yHit, noteH, u } = L;
    const y = yHit - noteH - 16 * u;
    ctx.font = fontJudge;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (let lane = 0; lane < CONFIG.LANES; lane++) {
      const fb = s.feedback(lane as Lane);
      if (!fb) continue;
      const age = s.now - fb.at;
      if (age < 0 || age >= FEEDBACK_S) continue;
      ctx.globalAlpha = 1 - age / FEEDBACK_S;
      outlinedText(ctx, fb.j, laneCenter(lane), y, JUDGE_COLORS[fb.j], Math.max(1, 4 * u));
    }
    ctx.globalAlpha = 1;
  }

  function drawHud(ctx: CanvasRenderingContext2D, s: RenderState): void {
    const { scale, u, yHit, hwX, hwW } = L;
    const st = s.stats;
    if (st.score !== scoreValue) {
      scoreValue = st.score;
      scoreText = st.score.toLocaleString("pt-BR");
    }
    ctx.font = fontScore;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    outlinedText(ctx, scoreText, 20 * scale, 16 * scale, "#fff", Math.max(1, 5 * scale));

    if (st.combo < COMBO_MIN) return;
    if (st.combo !== comboValue || st.multiplier !== comboMult) {
      comboValue = st.combo;
      comboMult = st.multiplier;
      comboText = `${st.combo} ${STRINGS.combo}  ×${st.multiplier}`;
    }
    ctx.font = fontCombo;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    outlinedText(ctx, comboText, hwX + hwW / 2, yHit - 70 * u, "#fff", Math.max(1, 5 * u));
  }

  return {
    renderFrame(ctx, s) {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      if (w === 0 || h === 0) return;
      if (w !== L.w || h !== L.h || !gradient) relayout(ctx, w, h);
      const rm = reducedMotion();
      drawBackground(ctx, s);
      drawHighway(ctx);
      drawTargets(ctx, s, rm);
      drawNotes(ctx, s);
      if (!rm) drawFeedback(ctx, s);
      drawHud(ctx, s);
    },
    forgetFrame() {
      hasFrame = false;
      lastFrame = null;
    },
  };
}
