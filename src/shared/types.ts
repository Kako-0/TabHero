export type Lane = 0 | 1 | 2 | 3;

export type AnalyzerMsg =
  | { type: "note"; id: number; t: number; lane: Lane; strength: number }
  | { type: "sustain-extend"; id: number; until: number }
  | { type: "sustain-end"; id: number; end: number }
  | { type: "reset-ack"; at: number };

export type AnalyzerCmd =
  | { type: "reset"; at: number } // descarta estado; ignora áudio antes de `at` (procTime)
  | { type: "set-active"; active: boolean };
