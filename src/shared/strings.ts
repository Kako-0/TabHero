// Toda string visível ao usuário, em pt-BR.
export const STRINGS = {
  appName: "TabHero",
  playButtonTooltip: "Jogar TabHero",
  soundOffWarning: "Ative o som do vídeo para jogar",
  errors: {
    SOURCE_TAKEN:
      "Outra extensão de áudio está usando este vídeo. Desative-a e recarregue a página.",
    WORKLET_LOAD_FAILED: "Não foi possível iniciar a análise de áudio. Recarregue a página.",
    CONTEXT_FAILED: "Não foi possível acessar o áudio do navegador. Recarregue a página.",
  },
} as const;
