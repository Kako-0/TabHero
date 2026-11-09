// Escudo de teclado (spec 06). Sem DOM: eventos sintéticos sobre EventTarget do Node.
import { describe, expect, it, vi } from "vitest";
import { installKeyboardShield, shouldShield } from "@/content/youtube";

interface FakeKeyInit {
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}

function key(type: "keydown" | "keyup", init: FakeKeyInit): KeyboardEvent {
  const e = new Event(type, { cancelable: true });
  const { target, ...rest } = init;
  Object.assign(
    e,
    { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false },
    rest,
  );
  const path = target === undefined ? [] : [target];
  Object.defineProperty(e, "composedPath", { value: () => path });
  return e as unknown as KeyboardEvent;
}

const insidePlayer = { tagName: "DIV" };
const playerEl = { contains: (n: unknown) => n === insidePlayer || n === overlayInput };
const overlayInput = { tagName: "INPUT" };
const searchBox = { tagName: "INPUT" };
const editableDiv = { tagName: "DIV", isContentEditable: true };

describe("shouldShield", () => {
  it.each([
    "KeyD",
    "KeyF",
    "KeyJ",
    "KeyK",
    "Space",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Digit0",
    "Digit5",
    "KeyM",
    "Comma",
    "Period",
    "KeyL",
    "Escape",
  ])("intercepta %s sem modificador", (code) => {
    expect(shouldShield(key("keydown", { code, target: insidePlayer }), playerEl)).toBe(true);
  });

  it("intercepta com Shift (Shift+N = próximo vídeo)", () => {
    expect(shouldShield(key("keydown", { code: "KeyN", shiftKey: true }), playerEl)).toBe(true);
  });

  it.each([
    ["ctrlKey", "KeyR"],
    ["ctrlKey", "KeyT"],
    ["metaKey", "KeyR"],
    ["altKey", "ArrowLeft"],
  ] as const)("deixa passar %s+%s (atalhos do navegador)", (mod, code) => {
    expect(shouldShield(key("keydown", { code, [mod]: true }), playerEl)).toBe(false);
  });

  it.each(["Tab", "F5", "F11", "F12"])("deixa passar %s", (code) => {
    expect(shouldShield(key("keydown", { code }), playerEl)).toBe(false);
  });

  it("não intercepta digitação em campo editável fora do player (busca)", () => {
    expect(shouldShield(key("keydown", { code: "KeyD", target: searchBox }), playerEl)).toBe(false);
    expect(shouldShield(key("keydown", { code: "Space", target: editableDiv }), playerEl)).toBe(
      false,
    );
  });

  it("intercepta em campo editável dentro do player", () => {
    expect(shouldShield(key("keydown", { code: "KeyD", target: overlayInput }), playerEl)).toBe(
      true,
    );
  });
});

describe("installKeyboardShield", () => {
  it("captura keydown/keyup: preventDefault, para a propagação e repassa ao jogo", () => {
    const win = new EventTarget();
    const handler = vi.fn();
    const youtube = vi.fn();
    const off = installKeyboardShield(handler, win, () => playerEl);
    win.addEventListener("keydown", youtube); // registrado depois: não pode rodar
    win.addEventListener("keyup", youtube);

    const down = key("keydown", { code: "KeyF" });
    win.dispatchEvent(down);
    const up = key("keyup", { code: "KeyF" });
    win.dispatchEvent(up);

    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(youtube).not.toHaveBeenCalled();

    off();
    win.dispatchEvent(key("keydown", { code: "KeyF" }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(youtube).toHaveBeenCalledTimes(1);
  });

  it("teclas com modificador seguem para a página sem chegar ao jogo", () => {
    const win = new EventTarget();
    const handler = vi.fn();
    const page = vi.fn();
    installKeyboardShield(handler, win, () => playerEl);
    win.addEventListener("keydown", page);
    const e = key("keydown", { code: "KeyR", ctrlKey: true });
    win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalledTimes(1);
  });
});
