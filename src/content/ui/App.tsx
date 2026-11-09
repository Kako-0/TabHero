// Telas por estado (spec 07). Versão funcional mínima da spec 06; o visual final vem no M2/M4.
import type { GameState, GameStats, PauseReason } from "@/content/game/game";
import { CONFIG } from "@/shared/config";
import { STRINGS } from "@/shared/strings";

export interface GameView {
  state: GameState;
  /** Segundos restantes da contagem (só em COUNTDOWN). */
  countdown: number | null;
  stats: GameStats | null;
  pauseReason: PauseReason | null;
  errorCode: string | null;
  /** Em RESULTS: há próximo vídeo (playlist, mix, autoplay) para o botão "Próxima música". */
  hasNext?: boolean;
  /** Muda a cada (re)início do SYNCING (seek de novo reinicia a barra). */
  syncId?: number;
}

export interface AppActions {
  onResume(): void;
  onExit(): void;
  onRestart(): void;
  onNext(): void;
}

export interface AppProps {
  /** Vídeo mudo ou no volume 0: o analisador recebe silêncio. */
  soundOff: boolean;
  view?: GameView;
  actions?: AppActions;
}

function errorMessage(code: string | null): string {
  const errors: Record<string, string> = STRINGS.errors;
  return (code && errors[code]) || STRINGS.errors.CONTEXT_FAILED;
}

function accuracy(s: GameStats): string {
  const total = s.perfect + s.good + s.miss;
  if (total === 0) return "—";
  return `${Math.round(((s.perfect + 0.5 * s.good) / total) * 100)}%`;
}

export function App({ soundOff, view, actions }: AppProps) {
  return (
    <>
      {soundOff && view?.state !== "AD" && (
        <div className="tabhero-banner" role="status" aria-live="polite">
          {STRINGS.soundOffWarning}
        </div>
      )}
      {view && <Screen view={view} actions={actions} />}
    </>
  );
}

function Screen({ view, actions }: { view: GameView; actions: AppActions | undefined }) {
  switch (view.state) {
    case "COUNTDOWN": {
      const n = Math.ceil(view.countdown ?? 0);
      return <div className="tabhero-big">{n > 0 ? n : STRINGS.go}</div>;
    }
    case "RESUMING":
      return <div className="tabhero-big">{Math.max(1, Math.ceil(view.countdown ?? 0))}</div>;
    case "PAUSED":
      // Buffering: pause automático, sem menu.
      if (view.pauseReason === "buffering") return null;
      return (
        <div className="tabhero-panel" role="dialog" aria-label={STRINGS.paused}>
          <h2>{STRINGS.paused}</h2>
          <div className="tabhero-buttons">
            <button onClick={actions?.onResume} autoFocus>
              {STRINGS.continue} <kbd>{STRINGS.spaceKey}</kbd>
            </button>
            <button onClick={actions?.onExit}>{STRINGS.exit}</button>
          </div>
          <p className="tabhero-hint">{STRINGS.pauseHint}</p>
        </div>
      );
    case "SYNCING":
      return (
        <div className="tabhero-sync" role="status">
          <div className="tabhero-msg">{STRINGS.syncing}</div>
          <div className="tabhero-bar" aria-hidden="true">
            <div
              key={view.syncId ?? 0}
              style={{ animationDuration: `${CONFIG.SYNC_AFTER_SEEK_S}s` }}
            />
          </div>
        </div>
      );
    case "AD":
      return (
        <div className="tabhero-banner tabhero-ad" role="status">
          {STRINGS.adBanner}
        </div>
      );
    case "RESULTS": {
      const s = view.stats;
      return (
        <div className="tabhero-panel" role="dialog" aria-label={STRINGS.results}>
          <h2>{STRINGS.results}</h2>
          {s && (
            <dl>
              <dt>{STRINGS.score}</dt>
              <dd>{s.score}</dd>
              <dt>{STRINGS.accuracy}</dt>
              <dd>{accuracy(s)}</dd>
              <dt>{STRINGS.perfect}</dt>
              <dd>{s.perfect}</dd>
              <dt>{STRINGS.good}</dt>
              <dd>{s.good}</dd>
              <dt>{STRINGS.miss}</dt>
              <dd>{s.miss}</dd>
              <dt>{STRINGS.maxCombo}</dt>
              <dd>{s.maxCombo}</dd>
            </dl>
          )}
          <div className="tabhero-buttons">
            <button onClick={actions?.onRestart} autoFocus>
              {STRINGS.playAgain}
            </button>
            {view.hasNext && <button onClick={actions?.onNext}>{STRINGS.nextSong}</button>}
            <button onClick={actions?.onExit}>{STRINGS.exit}</button>
          </div>
        </div>
      );
    }
    case "ERROR":
      return (
        <div className="tabhero-panel" role="alertdialog">
          <p>{errorMessage(view.errorCode)}</p>
          <div className="tabhero-buttons">
            <button onClick={actions?.onExit} autoFocus>
              {STRINGS.exit}
            </button>
          </div>
        </div>
      );
    default:
      return null;
  }
}
