export type RagIndexStage =
  | "prepare"
  | "access"
  | "download"
  | "detect"
  | "extract"
  | "ocr"
  | "embed"
  | "save"
  | "complete";

export interface RagIndexProgress {
  done: number;
  total: number;
  currentName: string;
  stage: RagIndexStage;
  detail: string;
}

export interface RagIndexLog {
  at: number;
  text: string;
  detail?: string;
  stage: RagIndexStage;
}

function ratioFromText(text: string): number | undefined {
  const percent = [...text.matchAll(/(\d{1,3})\s*%/g)].at(-1);
  if (percent) return Math.max(0, Math.min(1, Number(percent[1]) / 100));
  const ratios = [...text.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  const ratio = ratios.at(-1);
  if (!ratio || Number(ratio[2]) <= 0) return undefined;
  return Math.max(0, Math.min(1, Number(ratio[1]) / Number(ratio[2])));
}

export function ragStageStep(stage: RagIndexStage): number {
  if (stage === "prepare" || stage === "access") return 0;
  if (stage === "download") return 1;
  if (stage === "detect" || stage === "extract" || stage === "ocr") return 2;
  if (stage === "embed" || stage === "save") return 3;
  return 4;
}

/** Honest estimate based on pipeline boundaries plus any real ratio in detail text. */
export function estimateRagFileProgress(stage: RagIndexStage, detail = ""): number {
  const ratio = ratioFromText(detail);
  if (stage === "prepare") return 2;
  if (stage === "access") return 7;
  if (stage === "download") return 18;
  if (stage === "detect") return 25;
  if (stage === "extract") return Math.round(31 + (ratio ?? 0.15) * 17);
  if (stage === "ocr") return Math.round(48 + (ratio ?? 0.15) * 27);
  if (stage === "embed") return Math.round(76 + (ratio ?? 0.2) * 20);
  if (stage === "save") return 98;
  return 100;
}

export function estimateRagBatchProgress(
  done: number,
  total: number,
  stage: RagIndexStage,
  filePercent: number,
): number {
  if (total <= 0) return 0;
  const completedFiles = Math.max(0, Math.min(done, total));
  const activeFile = stage !== "complete" && completedFiles < total
    ? Math.max(0, Math.min(filePercent, 100)) / 100
    : 0;
  return Math.min(100, Math.max(1, Math.round(((completedFiles + activeFile) / total) * 100)));
}
