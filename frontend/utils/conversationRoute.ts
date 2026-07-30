export type ConversationScope = "general" | "document" | "image" | "tool";
export type ImageAction = "show" | "describe" | null;

export interface ConversationRoute {
  scope: ConversationScope;
  referencedSources: string[];
  imageAction: ImageAction;
  confidence: number;
}

export function normalizeConversationRoute(value: unknown, availableSources: string[]): ConversationRoute {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const validScope = ["general", "document", "image", "tool"].includes(String(record.scope));
  if (!validScope) return { scope: "general", referencedSources: [], imageAction: null, confidence: 0 };
  const scope = record.scope as ConversationScope;
  const allowed = new Set(availableSources);
  const referencedSources = (scope === "document" || scope === "image") && Array.isArray(record.referencedSources)
    ? [...new Set(record.referencedSources.filter((source): source is string => typeof source === "string" && allowed.has(source)))]
    : [];
  const imageAction: ImageAction = scope === "image" && ["show", "describe"].includes(String(record.imageAction))
    ? record.imageAction as Exclude<ImageAction, null>
    : null;
  const confidence = Math.max(0, Math.min(1, Number(record.confidence) || 0));
  return { scope, referencedSources, imageAction, confidence };
}
