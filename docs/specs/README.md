# TabHero — Especificações

Specs por módulo do MVP. A visão de arquitetura e as decisões (com motivos) estão em [`../../arquitetura_e_stack_do_guitar_hero_para_udio_do_navegador.md`](../../arquitetura_e_stack_do_guitar_hero_para_udio_do_navegador.md). **Em caso de conflito, a spec do módulo prevalece** sobre o documento de arquitetura.

## Índice

| # | Spec | Módulo(s) | Milestone |
| :--- | :--- | :--- | :--- |
| 00 | [Visão geral e convenções](00-visao-geral.md) | `src/shared/` | — |
| 01 | [Grafo de áudio](01-audio-graph.md) | `src/content/audioGraph.ts` | M0 |
| 02 | [Relógio e sincronia](02-clock-sync.md) | `src/content/clock.ts` | M0 |
| 03 | [Vídeo atrasado](03-video-delay.md) | `src/content/videoDelay.ts` | M0 |
| 04 | [Analisador em streaming](04-analyzer.md) | `src/analysis/`, `src/worklet/` | M1 |
| 05 | [Gameplay](05-gameplay.md) | `src/content/game/` | M2, M3 |
| 06 | [Integração com o YouTube](06-youtube-integration.md) | `src/content/youtube.ts`, `main.tsx` | M2 |
| 07 | [UI e renderização](07-ui-render.md) | `src/content/game/render.ts`, `src/content/ui/` | M2, M4 |
| 08 | [Suíte de qualidade](08-quality-suite.md) | `quality/` | M1 |
| 09 | [Esqueleto do projeto](09-esqueleto-projeto.md) | raiz, build, CI | **Setup** (antes do M0) |

## Milestones

| Milestone | Entrega | Specs | Pronto quando |
| :--- | :--- | :--- | :--- |
| **Setup — Esqueleto** | Repo, build MV3, worklet no-op carregando, testes, CI | 09 | Critérios de aceite de 09 |
| **M0 — Spikes** | Grafo de áudio com atraso, relógio, vídeo atrasado, worklet carregando no YouTube | 01, 02, 03 | Critérios de aceite de 01–03 + os riscos marcados como **SPIKE** respondidos e registrados na spec |
| **M1 — Analisador** | `streamAnalyzer` + suíte de qualidade com baseline | 04, 08 | F1 de onset ≥ 0,70 na suíte; baseline commitado |
| **M2 — Jogo jogável** | Overlay, início, julgamento, score, pause/seek/anúncio | 05, 06, 07 | Uma música inteira jogável do início ao fim sem intervenção manual |
| **M3 — Sustain** | Notas longas ao vivo | 04 (§sustain), 05 (§sustain) | Critérios de sustain em 04 e 05 |
| **M4 — Polimento** | Resultados, fullscreen, erros, Web Store | 05, 06, 07 | Checklist de release em 07 |

## Formato de cada spec
1. **Objetivo:** o que o módulo resolve.
2. **Fora de escopo.**
3. **Interface:** tipos/funções públicas em TypeScript. É o contrato entre módulos.
4. **Comportamento:** regras, algoritmos, estados.
5. **Erros e casos de borda.**
6. **Critérios de aceite:** checklist verificável.
7. **Testes:** o que é automatizado e o que é manual.
8. **Riscos / SPIKE:** perguntas que só a implementação responde. Atualizar a spec com a resposta.
