import { STRINGS } from "@/shared/strings";

export interface AppProps {
  /** Vídeo mudo ou no volume 0: o analisador recebe silêncio. */
  soundOff: boolean;
}

export function App({ soundOff }: AppProps) {
  return (
    <>
      {soundOff && (
        <div className="tabhero-banner" role="status" aria-live="polite">
          {STRINGS.soundOffWarning}
        </div>
      )}
      <div className="tabhero-placeholder">{STRINGS.appName}</div>
    </>
  );
}
