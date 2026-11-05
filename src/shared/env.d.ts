// Tipos do import.meta.env sem depender de "vite/client" (este arquivo também
// é checado pelo tsconfig.worklet.json, que não tem DOM).
interface ImportMetaEnv {
  readonly VITE_DEBUG?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
