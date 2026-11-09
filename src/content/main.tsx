// Bootstrap do content script (spec 06): injeta o botão "Jogar" em toda página /watch e,
// no clique, monta a partida: grafo de áudio, relógio, vídeo atrasado, jogo, overlay,
// escudo de teclado e a tradução dos eventos do player para o jogo.
import { CONFIG } from "@/shared/config";
import { DEBUG, error, log } from "@/shared/log";
import type { Lane } from "@/shared/types";
import { AudioGraph, AudioGraphError } from "./audioGraph";
import { createClock } from "./clock";
import { createGame, type Game } from "./game/game";
import { createGameEffects } from "./gameEffects";
import { isSoundOff, watchSound } from "./soundCheck";
import type { AppProps, GameView } from "./ui/App";
import { mountOverlay } from "./ui/mountOverlay";
import { createVideoDelay } from "./videoDelay";
import {
  findPlayer,
  installKeyboardShield,
  isWatchPage,
  onNavigateFinish,
  type YouTubePlayer,
} from "./youtube";

/** Escurecimento do vídeo atrasado em PAUSED/SYNCING (spec 07). */
const DIM_PAUSED = 0.7;
const DEBUG_LOG_MS = 2000;
/**
 * O jogo pausa o vídeo a isso do fim: sem `ended`, o YouTube não avança (autoplay, mix,
 * playlist) e a tela de resultados fica até o usuário escolher. > 0,25s: o `timeupdate`
 * (a cada ~250ms) também pega o fim com a aba em segundo plano (rAF parado).
 */
const HOLD_END_S = 0.3;
/** "Próxima música": espera o vídeo novo tocar até isso antes de começar mesmo assim. */
const AUTO_START_TIMEOUT_MS = 5000;

interface Session {
  close(): void;
  /** Encerra a partida pelo jogo (teardown completo) ou fecha direto se ainda não começou. */
  exit(): void;
}

let player: YouTubePlayer | null = null;
let session: Session | null = null;
/** "Próxima música": começa a partida sozinha quando o próximo vídeo começar a tocar. */
let autoStartNext = false;

/** Overlay só com a mensagem de erro + "Sair" (attach falhou, player trocado). */
function showError(p: YouTubePlayer, code: string): Session {
  const ov = mountOverlay(p.mountOverlayHost(), {
    soundOff: false,
    view: { state: "ERROR", errorCode: code, countdown: null, stats: null, pauseReason: null },
    actions: { onExit: () => s.close(), onResume() {}, onRestart() {}, onNext() {} },
  });
  const s: Session = {
    close() {
      ov.unmount();
      p.unmountOverlayHost();
      if (session === s) session = null;
    },
    exit() {
      s.close();
    },
  };
  return s;
}

function startSession(p: YouTubePlayer): Session {
  const video = p.video;
  const ov = mountOverlay(p.mountOverlayHost(), { soundOff: isSoundOff(video) });
  const canvas = ov.canvas;
  const c2d = canvas.getContext("2d", { alpha: false })!;
  const cleanups: (() => void)[] = [];
  let game: Game | null = null;
  let closed = false;
  let soundOff = isSoundOff(video);
  /** O jogo pausou o vídeo a HOLD_END_S do fim (o YouTube ainda não viu o `ended`). */
  let heldAtEnd = false;

  const actions = {
    onResume: () => game?.resume(),
    onExit: () => {
      const release = heldAtEnd;
      s.exit();
      // Solta o fim segurado: o vídeo termina e o YouTube segue o autoplay/playlist dele.
      if (release) video.play().catch(() => {});
    },
    onRestart: () => game?.start(),
    onNext: () => {
      s.exit();
      autoStartNext = p.goNext();
    },
  };
  const renderUi = () => {
    if (closed) return;
    let view: GameView | undefined;
    if (game) {
      // Anúncio antes do início: a partida espera o fim dele (ver ad-end abaixo).
      const state = game.state === "IDLE" && p.isAdShowing() ? "AD" : game.state;
      view = {
        state,
        countdown: game.countdown,
        stats: game.stats,
        pauseReason: game.pauseReason,
        errorCode: game.errorCode,
        hasNext: state === "RESULTS" && p.hasNext(),
      };
      // AD: o vídeo do anúncio aparece ao vivo por baixo (spec 06).
      canvas.style.visibility = state === "AD" ? "hidden" : "visible";
    }
    const props: AppProps = { soundOff, view, actions };
    ov.update(props);
  };
  cleanups.push(
    watchSound(video, (off) => {
      soundOff = off;
      renderUi();
    }),
  );

  const s: Session = {
    close() {
      if (closed) return;
      closed = true;
      for (const fn of cleanups.splice(0).reverse()) fn();
      p.setGameActive(false);
      ov.unmount();
      p.unmountOverlayHost();
      if (session === s) session = null;
    },
    exit() {
      // game.exit() → teardown → onTeardown → close(). Fora de jogo (IDLE), fecha direto.
      if (game && game.state !== "IDLE") game.exit();
      s.close();
    },
  };

  void (async () => {
    let g: AudioGraph;
    try {
      g = await AudioGraph.attach(video);
    } catch (e) {
      const code = e instanceof AudioGraphError ? e.code : "CONTEXT_FAILED";
      error("grafo de áudio:", code, e instanceof AudioGraphError ? e.cause : e);
      if (closed) return;
      s.close();
      session = showError(p, code);
      return;
    }
    if (closed) return g.dispose(); // fechado durante o attach
    cleanups.push(() => g.dispose());

    const clock = createClock(g);
    const vd = createVideoDelay(video, clock, { audioRms: () => g.inputRms() });
    cleanups.push(() => vd.stop());

    // Eventos de mídia causados pelo próprio jogo (spec 06): não voltam para o jogo.
    let ownPause = false;
    const fx = createGameEffects({
      graph: g,
      video,
      videoDelay: vd,
      clock,
      markOwnMediaEvent: (kind) => {
        if (kind === "pause" && !video.paused) ownPause = true;
      },
      onTeardown: () => s.close(),
    });
    const gm = createGame(fx);
    game = gm;
    gm.on("state", (st) => {
      if (st === "COUNTDOWN") heldAtEnd = false;
      if (DEBUG) log("jogo:", st, { score: gm.stats.score });
      renderUi();
    });

    // Analisador → jogo.
    const onMsg = (e: MessageEvent) => gm.onAnalyzerMsg(e.data);
    g.analyzerPort.addEventListener("message", onMsg);
    g.analyzerPort.start();
    cleanups.push(() => g.analyzerPort.removeEventListener("message", onMsg));

    // Fim da mídia segurado pelo jogo: pausa antes do `ended` e marca o fim da partida.
    const checkEnd = () => {
      if (heldAtEnd || (gm.state !== "PLAYING" && gm.state !== "SYNCING") || p.isAdShowing())
        return;
      const d = video.duration; // Infinity em live: nunca segura
      if (!Number.isFinite(d) || d - video.currentTime > HOLD_END_S) return;
      heldAtEnd = true;
      if (!video.paused) ownPause = true;
      video.pause();
      // endAt = procTime agora: o áudio atrasado ainda toca DELAY_S até o RESULTS.
      gm.ended(g.ctx.currentTime);
    };

    // <video> → jogo.
    const media: [string, () => void][] = [
      [
        "pause",
        () => {
          if (ownPause) {
            ownPause = false;
            return;
          }
          // No fim da mídia o <video> dispara `pause` antes de `ended`: não é pause do usuário.
          if (video.ended) return;
          gm.pause("user");
        },
      ],
      ["waiting", () => gm.state === "PLAYING" && gm.pause("buffering")],
      ["playing", () => gm.state === "PAUSED" && gm.pauseReason === "buffering" && gm.resume()],
      [
        "seeking",
        () => {
          heldAtEnd = false;
          gm.seeked();
        },
      ],
      ["timeupdate", checkEnd],
      // Se o fim escapou do checkEnd: endAt = procTime do fim da mídia, como antes.
      ["ended", () => gm.ended(g.ctx.currentTime)],
    ];
    for (const [ev, fn] of media) video.addEventListener(ev, fn);
    cleanups.push(() => {
      for (const [ev, fn] of media) video.removeEventListener(ev, fn);
    });

    // Player → jogo.
    cleanups.push(
      p.on("ad-start", () => {
        gm.adStarted();
        renderUi();
      }),
      p.on("ad-end", () => {
        if (gm.state === "IDLE") gm.start();
        else gm.adEnded();
        renderUi();
      }),
      p.on("navigate", () => s.exit()),
      p.on("player-lost", () => {
        s.exit();
        if (p.playerEl.isConnected) session = showError(p, "PLAYER_LOST");
      }),
    );

    // Teclado: D F J K → pistas; Espaço → pause/retomar; Esc → pause.
    const lanes: readonly string[] = CONFIG.KEYS;
    cleanups.push(
      installKeyboardShield((e) => {
        const lane = lanes.indexOf(e.code);
        if (lane >= 0) {
          if (e.repeat) return;
          const gt = clock.gameTimeAt(e.timeStamp);
          if (e.type === "keydown") gm.onKeyDown(lane as Lane, gt);
          else gm.onKeyUp(lane as Lane, gt);
          return;
        }
        if (e.type !== "keydown" || e.repeat) return;
        if (e.code === "Space") {
          // Em RESUMING, o pause cancela a contagem.
          if (gm.state === "PLAYING" || gm.state === "RESUMING") gm.pause("user");
          else if (gm.state === "PAUSED" && gm.pauseReason === "user") gm.resume();
        } else if (e.code === "Escape" && !document.fullscreenElement) {
          // Em tela cheia o Esc é do navegador (sai do fullscreen) e o jogo continua.
          gm.pause("user");
        }
      }),
    );

    // Loop (rAF): relógio → jogo → vídeo atrasado no canvas. Notas/HUD: spec 07.
    let drawn: ImageBitmap | null = null;
    let drawnDim = -1;
    let everDrawn = false;
    let lastCountdown: number | null = null;
    let lastLog = 0;
    let raf = 0;
    const tick = (now: number) => {
      clock.sample();
      const gt = clock.gameTime();
      // Relógio de parede: conta o RESUMING, em que o gameTime está congelado.
      gm.tick(gt, now / 1000);
      checkEnd();

      const cd = gm.countdown === null ? null : Math.ceil(gm.countdown);
      if (cd !== lastCountdown) {
        lastCountdown = cd;
        renderUi();
      }

      const dpr = Math.min(2, devicePixelRatio);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawn = null;
      }
      const dim = gm.state === "PAUSED" || gm.state === "SYNCING" ? DIM_PAUSED : CONFIG.VIDEO_DIM;
      const frame = vd.frameAt(gt);
      if (frame && (frame !== drawn || dim !== drawnDim)) {
        // cover
        const sc = Math.max(w / frame.width, h / frame.height);
        const fw = frame.width * sc;
        const fh = frame.height * sc;
        c2d.drawImage(frame, (w - fw) / 2, (h - fh) / 2, fw, fh);
        c2d.fillStyle = `rgba(0,0,0,${dim})`;
        c2d.fillRect(0, 0, w, h);
        drawn = frame;
        drawnDim = dim;
        everDrawn = true;
      } else if (!frame && (!everDrawn || drawn === null)) {
        // Nunca houve frame (início, DRM) ou o canvas foi redimensionado: fundo neutro.
        c2d.fillStyle = "#111";
        c2d.fillRect(0, 0, w, h);
        everDrawn = true;
        drawn = null;
        drawnDim = -1;
      }
      // Sem frame após seek: mantém o último desenhado (os bitmaps podem já estar fechados).

      if (DEBUG && now - lastLog >= DEBUG_LOG_MS) {
        lastLog = now;
        const st = vd.stats;
        const { outputLatency, outputTimestamp } = clock.latencySources();
        log("partida", {
          state: gm.state,
          gameTime: gt.toFixed(3),
          driftMs: ((clock.procTimeAt(performance.now()) - g.ctx.currentTime) * 1000).toFixed(2),
          latencyA_ms: (outputLatency * 1000).toFixed(1),
          latencyB_ms: outputTimestamp === null ? null : (outputTimestamp * 1000).toFixed(1),
          score: gm.stats.score,
          combo: gm.stats.combo,
          frames: st.frames,
          approxMB: (st.approxBytes / 2 ** 20).toFixed(1),
          leak: st.created - st.closed - st.frames,
          drmSuspected: vd.drmSuspected,
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    cleanups.push(() => cancelAnimationFrame(raf));

    p.setGameActive(true);
    // Anúncio na hora do clique: espera o fim dele para começar (ad-end → start).
    if (!p.isAdShowing()) gm.start();
    renderUi();
  })();

  return s;
}

function onPlayClick(p: YouTubePlayer) {
  // A barra fica escondida durante a partida; o 2º clique só é possível antes de ela começar.
  if (session) {
    session.exit();
    return;
  }
  session = startSession(p);
}

/**
 * "Próxima música": começa quando o vídeo novo estiver tocando (pronto, e com um eventual
 * anúncio já visível, que a sessão espera terminar). Sem `playing` em 5s, começa assim mesmo.
 */
function startWhenPlaying(p: YouTubePlayer) {
  const video = p.video;
  // Navegou de novo, ou o usuário já começou: não faz nada.
  const start = () => player === p && !session && onPlayClick(p);
  if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return start();
  const go = () => {
    video.removeEventListener("playing", go);
    clearTimeout(timer);
    start();
  };
  video.addEventListener("playing", go);
  const timer = setTimeout(go, AUTO_START_TIMEOUT_MS);
}

async function bootstrap() {
  session?.close();
  session = null;
  player?.dispose();
  player = null;
  if (!isWatchPage()) {
    autoStartNext = false;
    return;
  }
  try {
    const p = await findPlayer();
    // Outra navegação pode ter começado enquanto esperávamos o player.
    if (!isWatchPage()) return p.dispose();
    // Duas navegações seguidas: fica só o player do último bootstrap.
    (player as YouTubePlayer | null)?.dispose();
    player = p;
    p.injectPlayButton(() => onPlayClick(p));
    log("botão injetado", p.videoId);
    if (autoStartNext) {
      autoStartNext = false;
      startWhenPlaying(p);
    }
  } catch (e) {
    error(e);
  }
}

onNavigateFinish(() => void bootstrap());
void bootstrap();
