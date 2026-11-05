# 08 — Suíte de qualidade (`quality/`)

## Objetivo
Medir objetivamente a qualidade do analisador (04) e impedir regressões. O áudio passa pelo **mesmo `streamAnalyzer`**, em blocos de 128 amostras, simulando o tempo real em Node.

## Fora de escopo
Testar no navegador; medir a diversão (isso é o playtest, abaixo).

## Estrutura

```
quality/
  dataset/
    <id>/
      audio.wav            # mono ou estéreo, 44,1/48 kHz, ≤ 4 min
      onsets.txt           # um tempo (s) por linha, anotado manualmente
      meta.json            # { title, artist, genre, license, sourceUrl, padRegions?: [[s,e]...] }
  run.ts                   # roda o analisador e calcula as métricas
  baseline.json            # métricas aceitas (commitado)
  report.md                # gerado; não commitado
```

## Dataset
- ~10 faixas com **licença livre** (CC-BY/CC0, ex.: Free Music Archive, ccMixter), cobrindo: rock, metal, EDM, pop, rap, acústico (violão), piano solo, jazz, vocal a cappella e ambient (caso difícil).
- Anotação de onsets com o Sonic Visualiser (camada de instantes, exportada como texto), revisada ouvindo com clicks sobrepostos.
- `padRegions`: trechos sustentados (pads, notas longas) usados na métrica de sustain.
- Nenhum áudio protegido por direitos autorais no repositório. Se a licença não permitir redistribuição, o `meta.json` aponta o download e o `.wav` fica no `.gitignore`.

## Métricas (por faixa e agregadas)

| Métrica | Definição | Meta MVP |
| :--- | :--- | :--- |
| **F1 de onset** | Casamento 1-para-1 entre nota e onset anotado com tolerância de ±50ms (mesma lógica do `mir_eval.onset`) | ≥ 0,70 agregado |
| **Erro de tempo com sinal** | Média de `t_nota − t_anotado` dos pares casados | \|média\| ≤ 10ms; o valor alimenta `ANALYZER_OFFSET_S` |
| **Desvio do erro** | Desvio padrão do erro | ≤ 20ms |
| **Densidade** | Notas/s | 1–8, por faixa |
| **Distribuição por pista** | % de notas em cada pista | Cada pista entre 15% e 40% |
| **Sustain falso** | Sustains que começam fora de `padRegions` / total de sustains | ≤ 30% |
| **Cobertura de sustain** | Fração de `padRegions` coberta por sustains | ≥ 50% |
| **Latência de decisão** | `procTime` de emissão − `t` da nota (p95) | ≤ 0,22s |

## Execução
- `yarn quality` → roda todas as faixas, gera `report.md` (tabela por faixa + agregados + diff contra a baseline).
- `yarn quality --update-baseline` → regrava `baseline.json` (só em PR que justifica a mudança).
- `yarn quality --sweep K=1.0:2.0:0.25` → varredura de parâmetros (para calibrar o analisador).
- **CI:** falha se o F1 agregado cair mais de 0,02 em relação à baseline, ou se alguma meta da tabela for violada no agregado.

## Playtest
Checklist preenchido por música (`quality/playtest/<data>.md`):
- Dá para jogar do início ao fim?
- As notas seguem a música (ritmo e melodia)?
- O vídeo parece sincronizado com o som?
- Houve trechos frustrantes (densos demais, vazios demais, pistas aleatórias)? Em que minuto?
- Versão do analisador (hash do commit) e dispositivo de áudio (com fio / BT / alto-falante).

Os resultados do playtest guiam os ajustes, que são validados de novo pelas métricas antes do merge.

## Critérios de aceite
- [ ] Dataset com ≥ 10 faixas anotadas e licenças registradas.
- [ ] `yarn quality` roda em < 2 min localmente.
- [ ] Baseline inicial commitada no M1 com as metas da tabela atendidas (ou desvios justificados aqui).
