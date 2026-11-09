import { describe, expect, it } from "vitest";
import { createStreamAnalyzer, type StreamAnalyzer } from "@/analysis/streamAnalyzer";
import { CONFIG } from "@/shared/config";
import type { AnalyzerMsg } from "@/shared/types";

const SR = 48000;
const BLOCK = 128;
const BLANK = CONFIG.BLANK_AFTER_RESET_S;

type Note = Extract<AnalyzerMsg, { type: "note" }>;
interface Emitted {
  msg: AnalyzerMsg;
  /** procTime do fim do bloco em que a mensagem saiu. */
  at: number;
}

/** Gerador determinístico (LCG) para ruído reprodutível. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Roda o sinal em blocos de 128 (como o worklet). `onBlock` pode injetar comandos. */
function run(
  signal: Float32Array,
  opts: {
    t0?: number;
    analyzer?: StreamAnalyzer;
    onBlock?: (t: number, a: StreamAnalyzer) => AnalyzerMsg[];
  } = {},
): Emitted[] {
  const a = opts.analyzer ?? createStreamAnalyzer(SR);
  const t0 = opts.t0 ?? 0;
  const out: Emitted[] = [];
  for (let s = 0; s + BLOCK <= signal.length; s += BLOCK) {
    const t = t0 + s / SR;
    for (const msg of opts.onBlock?.(t, a) ?? []) out.push({ msg, at: t });
    for (const msg of a.push(signal.subarray(s, s + BLOCK), t))
      out.push({ msg, at: t + BLOCK / SR });
  }
  return out;
}

const notes = (e: Emitted[]): Note[] =>
  e.map((x) => x.msg).filter((m): m is Note => m.type === "note");

/** Notas com t arredondado a 1µs (ignora ruído de ponto flutuante). */
const summary = (ns: Note[]) => ns.map((n) => [n.id, Math.round(n.t * 1e6), n.lane]);

function clicks(
  seconds: number,
  perSecond: number,
  start = 0,
): { x: Float32Array; times: number[] } {
  const x = new Float32Array(Math.round(seconds * SR));
  const times: number[] = [];
  for (let t = start; t < seconds - 0.01; t += 1 / perSecond) {
    const i = Math.round(t * SR);
    times.push(i / SR);
    for (let j = 0; j < 48; j++) x[i + j] = (j % 2 ? -1 : 1) * 0.8 * Math.exp(-j / 12);
  }
  return { x, times };
}

/** Tom com ataque: sobe em 2ms, pico 1 decaindo para `sustainLevel` em ~30ms. */
function tone(
  x: Float32Array,
  start: number,
  dur: number,
  freq: number,
  { sustainLevel = 0.8, decayTo }: { sustainLevel?: number; decayTo?: number } = {},
): void {
  const i0 = Math.round(start * SR);
  const n = Math.round(dur * SR);
  for (let j = 0; j < n && i0 + j < x.length; j++) {
    const t = j / SR;
    const attack = Math.min(1, t / 0.002);
    let env: number;
    if (decayTo !== undefined)
      env = Math.pow(decayTo, t / dur); // decai até `decayTo` no fim
    else env = sustainLevel + (1 - sustainLevel) * Math.exp(-t / 0.01);
    const release = Math.min(1, (n - j) / (0.03 * SR));
    x[i0 + j]! += 0.5 * attack * release * env * Math.sin(2 * Math.PI * freq * t);
  }
}

describe("streamAnalyzer (sintéticos, spec 04)", () => {
  it("clicks a 120 BPM: 1 nota por click após o blank, erro ≤ 12ms", () => {
    const { x, times } = clicks(10, 2, 0.25);
    const e = run(x);
    const ns = notes(e);
    const expected = times.filter((t) => t >= BLANK);
    expect(ns).toHaveLength(expected.length);
    ns.forEach((n, k) => expect(Math.abs(n.t - expected[k]!)).toBeLessThanOrEqual(0.012));
  });

  it("latência de decisão: toda nota sai até t + 0,22s", () => {
    const { x } = clicks(10, 3, 0.1);
    const e = run(x);
    const emitted = e.filter((m) => m.msg.type === "note");
    expect(emitted.length).toBeGreaterThan(10);
    for (const { msg, at } of emitted) expect(at - (msg as Note).t).toBeLessThanOrEqual(0.22);
  });

  it("silêncio: 0 notas", () => {
    expect(notes(run(new Float32Array(10 * SR)))).toHaveLength(0);
  });

  it("ruído branco constante: ≤ 2 notas", () => {
    const r = rng(42);
    const x = new Float32Array(10 * SR).map(() => 0.3 * (r() * 2 - 1));
    expect(notes(run(x)).length).toBeLessThanOrEqual(2);
  });

  it("escada de tons: pistas não decrescentes depois de 12 onsets", () => {
    const freqs = [180, 320, 550, 900, 1400, 2100, 3200, 4500];
    const passes = 3;
    const start = 2.5;
    const x = new Float32Array(Math.round((start + passes * 4 + 0.5) * SR));
    for (let p = 0; p < passes; p++)
      freqs.forEach((f, k) => tone(x, start + p * 4 + k * 0.5, 0.45, f));
    const ns = notes(run(x));
    expect(ns).toHaveLength(passes * freqs.length);
    for (let p = 0; p < passes; p++) {
      const lanes = ns.slice(p * 8, p * 8 + 8).map((n) => n.lane);
      for (let k = 1; k < lanes.length; k++) {
        if (p * 8 + k < 12) continue;
        expect(lanes[k]!).toBeGreaterThanOrEqual(lanes[k - 1]!);
      }
      expect(lanes[0]).toBe(0);
      expect(lanes[7]).toBe(3);
    }
  });

  it("sustain: tom de 440 Hz por 1,5s → 1 nota + sustain-end em ≈ 1,5s", () => {
    const start = 3;
    const x = new Float32Array(6 * SR);
    tone(x, start, 1.5, 440);
    const msgs = run(x).map((m) => m.msg);
    const ns = notes(run(x));
    expect(ns).toHaveLength(1);
    const ends = msgs.filter((m) => m.type === "sustain-end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ id: ns[0]!.id });
    expect(Math.abs((ends[0] as { end: number }).end - (start + 1.5))).toBeLessThanOrEqual(0.06);
    const ext = msgs.filter((m) => m.type === "sustain-extend") as { until: number }[];
    expect(ext.length).toBeGreaterThan(5);
    expect(ext[0]!.until).toBeCloseTo(ns[0]!.t + CONFIG.SUSTAIN_MIN_S, 6);
    for (let k = 1; k < ext.length; k++) expect(ext[k]!.until).toBeGreaterThan(ext[k - 1]!.until);
  });

  it("notas repetidas: 4 ataques do mesmo tom (250ms) → 4 notas, sem sustain", () => {
    const start = 3;
    const x = new Float32Array(5 * SR);
    for (let k = 0; k < 4; k++) tone(x, start + k * 0.25, 0.25, 440, { decayTo: 0.15 });
    const msgs = run(x).map((m) => m.msg);
    const ns = notes(run(x));
    expect(ns).toHaveLength(4);
    ns.forEach((n, k) => expect(Math.abs(n.t - (start + k * 0.25))).toBeLessThanOrEqual(0.03));
    expect(msgs.some((m) => m.type === "sustain-extend")).toBe(false);
  });

  it("densidade: clicks a 20/s → ≤ 8 notas em qualquer janela de 1s", () => {
    const { x } = clicks(10, 20);
    const ts = notes(run(x)).map((n) => n.t);
    expect(ts.length).toBeGreaterThan(0);
    for (const t of ts)
      expect(ts.filter((u) => u >= t && u <= t + 1).length).toBeLessThanOrEqual(8);
  });

  it("reset no meio: nenhuma nota com t < at + blank, e reset-ack", () => {
    const { x } = clicks(12, 2, 0.25);
    const at = 5.1;
    let done = false;
    const e = run(x, {
      onBlock: (t, a) => {
        if (done || t < 5) return [];
        done = true;
        return a.reset(at);
      },
    });
    const msgs = e.map((m) => m.msg);
    expect(msgs).toContainEqual({ type: "reset-ack", at });
    const ackIdx = msgs.findIndex((m) => m.type === "reset-ack");
    const after = notes(e.slice(ackIdx));
    expect(after.length).toBeGreaterThan(0);
    for (const n of after) expect(n.t).toBeGreaterThanOrEqual(at + BLANK);
    // antes do reset havia notas normais
    expect(notes(e.slice(0, ackIdx)).length).toBeGreaterThan(0);
  });

  it("reset encerra o sustain ativo com sustain-end", () => {
    const x = new Float32Array(6 * SR);
    tone(x, 3, 2.5, 440);
    let done = false;
    const msgs = run(x, {
      onBlock: (t, a) => {
        if (done || t < 4.2) return [];
        done = true;
        return a.reset(t);
      },
    }).map((m) => m.msg);
    const id = notes(msgs.map((msg) => ({ msg, at: 0 })))[0]!.id;
    const ackIdx = msgs.findIndex((m) => m.type === "reset-ack");
    expect(msgs[ackIdx - 1]).toMatchObject({ type: "sustain-end", id });
  });

  it("determinismo: mesma entrada → mesmas mensagens, independente do tamanho do bloco", () => {
    const r = rng(7);
    const x = new Float32Array(8 * SR);
    for (let k = 0; k < 20; k++) tone(x, 2 + k * 0.29, 0.25, 200 + r() * 3000);
    const a = notes(run(x));
    const b = notes(run(x));
    expect(b).toEqual(a);
    // blocos de 1024 em vez de 128
    const an = createStreamAnalyzer(SR);
    const c: AnalyzerMsg[] = [];
    for (let s = 0; s + 1024 <= x.length; s += 1024)
      c.push(...an.push(x.subarray(s, s + 1024), s / SR));
    // O AGC suaviza por bloco: muda o tempo em < 2ms (interpolação do pico), não as notas.
    const big = notes(c.map((msg) => ({ msg, at: 0 })));
    expect(big.map((n) => n.lane)).toEqual(a.map((n) => n.lane));
    big.forEach((n, k) => expect(Math.abs(n.t - a[k]!.t)).toBeLessThan(0.002));
    expect(a.length).toBeGreaterThan(10);
  });

  it("buraco no fluxo (set-active off/on) recomeça com blank", () => {
    const { x } = clicks(6, 2, 0.25);
    const a = createStreamAnalyzer(SR);
    run(x, { analyzer: a });
    const e = run(x, { analyzer: a, t0: 100 });
    for (const n of notes(e)) expect(n.t).toBeGreaterThanOrEqual(100 + BLANK);
    expect(notes(e).length).toBeGreaterThan(0);
  });

  it("volume do vídeo não muda as notas (ganho automático)", () => {
    const { x } = clicks(8, 4, 0.1);
    const quiet = x.map((v) => v * 0.05);
    expect(summary(notes(run(quiet)))).toEqual(summary(notes(run(x))));
  });
});
