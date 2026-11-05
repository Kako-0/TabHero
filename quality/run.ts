// Suíte de qualidade do analisador (spec 08). Setup: só detecta o dataset vazio.
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const datasetDir = join(here, "dataset");

const tracks = readdirSync(datasetDir).filter((name) =>
  statSync(join(datasetDir, name)).isDirectory(),
);

if (tracks.length === 0) {
  console.log("[TabHero] quality: dataset vazio");
  process.exit(0);
}

console.log(`[TabHero] quality: ${tracks.length} faixa(s); avaliação implementada no M1`);
