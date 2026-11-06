import { describe, expect, it, vi } from "vitest";
import { isSoundOff, watchSound } from "@/content/soundCheck";

class FakeVideo extends EventTarget {
  muted = false;
  volume = 1;
  set(p: Partial<{ muted: boolean; volume: number }>) {
    Object.assign(this, p);
    this.dispatchEvent(new Event("volumechange"));
  }
}
const asMedia = (v: FakeVideo) => v as unknown as HTMLMediaElement;

describe("soundCheck", () => {
  it("mudo ou volume 0 = sem som; volume baixo não", () => {
    const v = new FakeVideo();
    expect(isSoundOff(asMedia(v))).toBe(false);
    v.volume = 0.01;
    expect(isSoundOff(asMedia(v))).toBe(false);
    v.volume = 0;
    expect(isSoundOff(asMedia(v))).toBe(true);
    v.volume = 1;
    v.muted = true;
    expect(isSoundOff(asMedia(v))).toBe(true);
  });

  it("avisa só nas transições e para após cancelar", () => {
    const v = new FakeVideo();
    const fn = vi.fn();
    const stop = watchSound(asMedia(v), fn);
    v.set({ volume: 0.5 }); // continua com som
    v.set({ muted: true });
    v.set({ volume: 0 }); // continua sem som
    v.set({ muted: false, volume: 0.3 });
    expect(fn.mock.calls).toEqual([[true], [false]]);
    stop();
    v.set({ muted: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
