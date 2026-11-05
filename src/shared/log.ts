// Sem DOM: roda no content script e no worklet.
export const DEBUG: boolean = import.meta.env.VITE_DEBUG === "true";

const PREFIX = "[TabHero]";

export function log(...args: unknown[]): void {
  if (DEBUG) console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  if (DEBUG) console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  if (DEBUG) console.error(PREFIX, ...args);
}
