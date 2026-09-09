export const EMBEDDING_DIMENSIONS = 768;

/** Validates provider vectors before either gateway or browser indexes consume them. */
export function normalizeEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS
    || !value.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error("Invalid embedding vector");
  }
  const magnitude = Math.hypot(...value);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error("Invalid embedding magnitude");
  return value.map((entry) => entry / magnitude);
}
