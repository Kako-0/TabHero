import { describe, expect, it } from "vitest";
import { createStreamAnalyzer } from "@/analysis/streamAnalyzer";
import { CONFIG } from "@/shared/config";
import type { AnalyzerMsg, Lane } from "@/shared/types";
import { installAudioContextMock } from "./setup";

describe("smoke", () => {
  it("CONFIG tem 4 pistas e 4 teclas", () => {
    expect(CONFIG.LANES).toBe(4);
    expect(CONFIG.KEYS).toHaveLength(CONFIG.LANES);
  });

  it("streamAnalyzer não gera notas com silêncio", () => {
    const a = createStreamAnalyzer(CONFIG.ANALYSIS_SR);
    expect(a.push(new Float32Array(CONFIG.HOP), 0)).toEqual([]);
  });

  it("reset responde reset-ack", () => {
    const lane: Lane = 0;
    const a = createStreamAnalyzer(CONFIG.ANALYSIS_SR);
    const msgs: AnalyzerMsg[] = a.reset(1.25);
    expect(msgs).toEqual([{ type: "reset-ack", at: 1.25 }]);
    expect(lane).toBe(0);
  });

  it("mock de Web Audio instala AudioContext", () => {
    installAudioContextMock();
    const ctx = new AudioContext();
    expect(ctx.sampleRate).toBeGreaterThan(0);
  });
});
