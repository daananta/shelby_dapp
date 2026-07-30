import { getStoredCloudApiKey } from "@/utils/cloudKeyStorage";
import { localize } from "@/i18n";

export type EmbeddingProvider = "gemini" | "gateway";
export const RAG_GATEWAY_URL = (import.meta.env.VITE_RAG_PIPELINE_API_URL ?? "").replace(/\/$/, "");
const GEMINI_EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents";

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

async function embedRemote(
  texts: string[],
  kind: "query" | "passage",
  provider: "gemini" | "gateway",
  apiKey?: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<number[][]> {
  const output: number[][] = [];
  const batchSize = provider === "gateway" ? 32 : 20;
  const key = apiKey?.trim() || getStoredCloudApiKey();
  if (provider === "gemini" && !key) throw new Error(localize("A Gemini API key is required for semantic search.", "Cần Gemini API key để tạo tìm kiếm theo ý nghĩa."));
  if (provider === "gateway" && !RAG_GATEWAY_URL) throw new Error(localize("The app's semantic search service is not configured.", "Dịch vụ tìm kiếm theo ý nghĩa của ứng dụng chưa được cấu hình."));

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    signal?.throwIfAborted();
    const batch = texts.slice(offset, offset + batchSize);
    const response = provider === "gateway"
      ? await fetch(`${RAG_GATEWAY_URL}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: batch, kind }),
        cache: "no-store",
        credentials: "same-origin",
        signal,
      })
      : await fetch(GEMINI_EMBEDDING_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: "models/gemini-embedding-001",
            content: { parts: [{ text }] },
            taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: 768,
          })),
        }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      });
    signal?.throwIfAborted();
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new Error(localize(
        `Semantic search provider ${provider} failed (${response.status})${detail ? `: ${detail}` : ""}`,
        `Nguồn tạo tìm kiếm theo ý nghĩa ${provider} thất bại (${response.status})${detail ? `: ${detail}` : ""}`,
      ));
    }
    const payload = await response.json() as { embeddings?: Array<{ values?: number[] }>; vectors?: number[][] };
    const vectors = payload.vectors ?? payload.embeddings?.map((item) => item.values ?? []) ?? [];
    if (vectors.length !== batch.length || vectors.some((vector) => !vector.length)) throw new Error(localize(
      `Semantic search provider ${provider} returned incomplete data.`,
      `Nguồn tạo tìm kiếm theo ý nghĩa ${provider} trả dữ liệu không đầy đủ.`,
    ));
    output.push(...vectors.map(normalizeVector));
    onProgress?.(`Embedding ${provider}: ${Math.min(offset + batch.length, texts.length)}/${texts.length} chunks…`);
  }
  return output;
}

export async function embedTexts(
  texts: string[],
  kind: "query" | "passage",
  onProgress?: (message: string) => void,
  provider: EmbeddingProvider = "gemini",
  apiKey?: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (!texts.length) return [];
  return embedRemote(texts, kind, provider, apiKey, onProgress, signal);
}

export function isEmbeddingModelLoaded(): boolean {
  return false;
}
