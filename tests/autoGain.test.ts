import { describe, expect, it } from "vitest";
import { AutoGain, type AutoGainConfig } from "@/analysis/autoGain";
import { StreamAnalyzer } from "@/analysis/streamAnalyzer";

const SR = 48000;
const BLOCK = 128;
const CFG: AutoGainConfig = { targetRms: 0.1, tauS: 3, maxGain: 1000, silenceRms: 1e-5 };

/** Senoide em blocos de 128 (como o worklet), com amplitude por bloco. */
function* sine(seconds: number, amp: (t: number) => number, freq = 440) {
  const blocks = Math.round((seconds * SR) / BLOCK);
  for (let b = 0; b < blocks; b++) {
    const block = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const n = b * BLOCK + i;
      block[i] = amp(n / SR) * Math.sin((2 * Math.PI * freq * n) / SR);
    }
    yield block;
  }
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

function runAndMeasureTail(agc: AutoGain, gen: Iterable<Float32Array>, tailBlocks = 400): number {
  const tail: number[] = [];
  for (const b of gen) {
    tail.push(rms(agc.process(b)));
    if (tail.length > tailBlocks) tail.shift();
  }
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

describe("AutoGain", () => {
  it.each([1, 0.3, 0.05, 0.005])("normaliza para o RMS alvo com amplitude %s", (amp) => {
    const agc = new AutoGain(SR, CFG);
    const out = runAndMeasureTail(
      agc,
      sine(2, () => amp),
    );
    expect(out).toBeCloseTo(CFG.targetRms, 2);
  });

  it("já começa calibrado no primeiro bloco com som", () => {
    const agc = new AutoGain(SR, CFG);
    const [first] = sine(0.01, () => 0.01);
    expect(rms(agc.process(first!))).toBeCloseTo(CFG.targetRms, 2);
  });

  /** Mede a saída final e a maior variação de ganho entre blocos. */
  function volumeChange(from: number, to: number, afterS: number, tailBlocks = 40) {
    const agc = new AutoGain(SR, CFG);
    let prev: number | null = null;
    let maxStep = 0;
    const probe = {
      process(b: Float32Array) {
        const out = agc.process(b);
        if (prev !== null) maxStep = Math.max(maxStep, Math.abs(agc.gain / prev - 1));
        prev = agc.gain;
        return out;
      },
    } as AutoGain;
    const tail = runAndMeasureTail(
      probe,
      sine(2 + afterS, (t) => (t < 2 ? from : to)),
      tailBlocks,
    );
    return { tail, maxStep };
  }

  it("volume sobe 20×: ataque rápido (< 3× o alvo em 0,5s) e converge em ~1 tau", () => {
    const fast = volumeChange(0.025, 0.5, 0.5, 4);
    expect(fast.tail / CFG.targetRms).toBeLessThan(3);
    const { tail } = volumeChange(0.025, 0.5, CFG.tauS);
    expect(tail / CFG.targetRms).toBeGreaterThan(0.9);
    expect(tail / CFG.targetRms).toBeLessThan(1.5);
  });

  it("volume cai 20×: −6 dB em 5 tau e converge em ~8 tau (média linear)", () => {
    expect(volumeChange(0.5, 0.025, 5 * CFG.tauS).tail / CFG.targetRms).toBeGreaterThan(0.45);
    const { tail, maxStep } = volumeChange(0.5, 0.025, 8 * CFG.tauS);
    expect(tail / CFG.targetRms).toBeGreaterThan(0.9);
    expect(maxStep).toBeLessThan(0.01); // sem saltos: < 1% de ganho por bloco
  });

  it("preserva a dinâmica de curto prazo (ataques continuam mais altos que o fundo)", () => {
    const agc = new AutoGain(SR, CFG);
    for (const b of sine(3, () => 0.05)) agc.process(b);
    const [loud] = sine(0.01, () => 0.5);
    expect(rms(agc.process(loud!)) / CFG.targetRms).toBeGreaterThan(8);
  });

  it("silêncio (mudo) congela o ganho e não gera NaN", () => {
    const agc = new AutoGain(SR, CFG);
    for (const b of sine(1, () => 0.2)) agc.process(b);
    const before = agc.gain;
    const out = agc.process(new Float32Array(BLOCK));
    expect(agc.gain).toBe(before);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("silêncio desde o início mantém ganho 1", () => {
    const agc = new AutoGain(SR, CFG);
    agc.process(new Float32Array(BLOCK));
    expect(agc.gain).toBe(1);
  });

  it("limita o ganho máximo", () => {
    const agc = new AutoGain(SR, CFG);
    for (const b of sine(0.1, () => 2e-5)) agc.process(b);
    expect(agc.gain).toBe(CFG.maxGain);
  });

  it("reaproveita o buffer de saída (sem alocação por bloco)", () => {
    const agc = new AutoGain(SR, CFG);
    const [a, b] = sine(0.01, () => 0.1);
    expect(agc.process(a!).buffer).toBe(agc.process(b!).buffer);
  });

  it("StreamAnalyzer aceita o sample rate de entrada", () => {
    const a = new StreamAnalyzer(SR);
    expect(a.push(new Float32Array(BLOCK), 0)).toEqual([]);
  });
});
