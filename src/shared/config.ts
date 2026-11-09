/** SPIKE 1 da spec 02: qual fonte de latência de saída o relógio aplica. */
export type LatencySource = "output-latency" | "output-timestamp";

export const CONFIG = {
  DELAY_S: 1.5, // atraso do áudio e do vídeo
  VISIBLE_LEAD_S: 1.25, // quanto tempo a nota leva do topo da pista até a linha de acerto
  COUNTDOWN_S: 3.0,
  RESUME_COUNTDOWN_S: 3.0, // contagem ao sair do pause (relógio de parede: a ctx está suspensa)
  VIDEO_PLAY_AT_COUNTDOWN_S: 1.5, // video.play() nesse instante da contagem → som começa no "GO"
  SYNC_AFTER_SEEK_S: 1.5,

  ANALYSIS_SR: 22050,
  FFT_SIZE: 2048,
  HOP: 256,
  ANALYSIS_LOOKAHEAD_S: 0.2,
  AGC_TARGET_RMS: 0.1, // ganho automático na entrada do analisador (independe de video.volume)
  AGC_TAU_S: 3,
  AGC_MAX_GAIN: 1000, // +60 dB
  AGC_SILENCE_RMS: 1e-5, // −100 dBFS: abaixo disso o ganho fica congelado
  ONSET_K: 1.5, // threshold adaptativo: mediana + K·MAD + δ (spec 04)
  ONSET_DELTA_RATIO: 0.1, // δ = ONSET_DELTA_RATIO · máximo móvel
  ONSET_MIN_GAP_S: 0.06,
  ONSET_ENERGY_GATE: 0.8, // onset exige rms(depois) ≥ gate·rms(antes): descarta fins de nota
  ANALYZER_OFFSET_S: -0.016, // t da nota = procTime do pico − offset (sintéticos: −17ms clicks, −14ms tons; refinar na suíte 08)
  LANE_MIN_GAP_S: 0.1,
  MAX_NOTES_PER_S: 8,
  LANE_WINDOW_S: 8,
  BLANK_AFTER_RESET_S: 2,
  SUSTAIN_MIN_S: 0.4,
  SUSTAIN_ENERGY_RATIO: 0.6,
  SUSTAIN_PITCH_TOLERANCE_SEMITONES: 1,
  SUSTAIN_MIN_CLARITY: 0.6,
  SUSTAIN_EXTEND_INTERVAL_S: 0.05,

  LANES: 4,
  KEYS: ["KeyD", "KeyF", "KeyJ", "KeyK"] as const,
  WINDOW_PERFECT_S: 0.045,
  WINDOW_GOOD_S: 0.09,
  WINDOW_MISS_S: 0.135,
  SUSTAIN_TICK_S: 0.1,
  SUSTAIN_RELEASE_TOLERANCE_S: 0.09,
  SCORE_PERFECT: 100,
  SCORE_GOOD: 50,
  SCORE_TICK: 10,
  COMBO_STEP: 10,
  MAX_MULTIPLIER: 4,

  FRAME_W: 640,
  FRAME_H: 360,
  FRAME_BUFFER_S: 2.0, // teto de histórico: DELAY_S + latência de saída (até ~0,4s) + folga
  FRAME_BUDGET_BYTES: 64 * 1024 * 1024, // acima disso, captura 1 a cada 2 frames (spec 03)
  VIDEO_OFFSET_S: 0, // SPIKE 1 da spec 03: frame exibido vs áudio na MediaElementSource (medir com vídeo de clap)
  DRM_CHECK_FRAMES: 10, // frames pretos seguidos, com áudio, para suspeitar de DRM
  DRM_BLACK_MAX: 16, // canal (0–255) máximo de um pixel "preto"
  DRM_AUDIO_RMS: 0.003, // ≈ −50 dBFS: abaixo disso o áudio conta como silêncio
  VIDEO_DIM: 0.4,
  OUTPUT_LATENCY_POLL_MS: 2000,
  LATENCY_SOURCE: "output-latency" as LatencySource, // A = outputLatency+baseLatency; B = getOutputTimestamp

  CLOCK_WINDOW: 60, // amostras (rAF) na regressão perf → procTime
  CLOCK_MIN_SAMPLES: 10, // abaixo disso: última amostra + Δperf
  CLOCK_SLOPE_MIN: 0.999, // inclinação (s de ctx por s de perf) travada nesse intervalo
  CLOCK_SLOPE_MAX: 1.001,
  CLOCK_OUTLIER_S: 0.05, // amostra fora da reta por mais que isso → resync automático
} as const;
