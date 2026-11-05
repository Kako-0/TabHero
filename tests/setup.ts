// Mocks globais de Web Audio. Importar explicitamente só nos testes que precisam.
import { AudioContext, AudioWorkletNode } from "standardized-audio-context-mock";

export function installAudioContextMock(): void {
  Object.assign(globalThis, { AudioContext, AudioWorkletNode });
}
