import { describe, expect, it } from "vitest";
import { StreamAnalyzer } from "@/analysis/streamAnalyzer";
import { CONFIG } from "@/shared/config";
import type { AnalyzerMsg, Lane } from "@/shared/types";
import { installAudioContextMock } from "./setup";

describe("smoke", () => {
  it("CONFIG tem 4 pistas e 4 teclas", () => {
    expect(CONFIG.LANES).toBe(4);
    expect(CONFIG.KEYS).toHaveLength(CONFIG.LANES);
  });

  it("streamAnalyzer stub não gera notas", () => {
    const a = new StreamAnalyzer();
    expect(a.push(new Float32Array(CONFIG.HOP), 0)).toEqual([]);
  });

  it("reset responde reset-ack", () => {
    const lane: Lane = 0;
    const a = new StreamAnalyzer();
    const msgs: AnalyzerMsg[] = a.command({ type: "reset", at: 1.25 });
    expect(msgs).toEqual([{ type: "reset-ack", at: 1.25 }]);
    expect(lane).toBe(0);
  });

  it("mock de Web Audio instala AudioContext", () => {
    installAudioContextMock();
    const ctx = new AudioContext();
    expect(ctx.sampleRate).toBeGreaterThan(0);
  });
});
