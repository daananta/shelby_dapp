interface MemoryMessage {
  role: "user" | "ai";
  text: string;
  sources?: unknown[];
  tool?: string;
  toolObservation?: {
    version: 1;
    kind: "blob_inventory";
    status: "verified" | "stale" | "not_loaded";
    observedAt: number;
    fetchedAt?: number;
  };
  imageUrls?: string[];
}

const DOCUMENT_TOOLS = new Set(["document_lookup", "document_inventory", "blob_inventory", "show_images"]);

/**
 * Keeps Cloud AI memory scoped: general chat never receives RAG/tool outputs,
 * while document chat only receives prior grounded document turns.
 */
export function buildScopedGeminiHistory(messages: MemoryMessage[], scope: "general" | "document") {
  const output: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index];
    const answer = messages[index + 1];
    if (user.role !== "user" || answer.role !== "ai") continue;
    const documentGrounded = Boolean(answer.sources?.length || (answer.tool && DOCUMENT_TOOLS.has(answer.tool)) || answer.imageUrls?.length);
    if ((scope === "document") !== documentGrounded) continue;
    output.push({ role: "user", parts: [{ text: user.text }] }, { role: "model", parts: [{ text: answer.text }] });
    index += 1;
  }
  return output.slice(-10);
}

/**
 * Recent conversational text for the adaptive agent. Source records and tool
 * payloads are intentionally omitted so document data can only enter through
 * the explicit knowledge-search tool.
 */
export function buildAdaptiveGeminiHistory(messages: MemoryMessage[]) {
  const output: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index];
    const answer = messages[index + 1];
    if (user.role !== "user" || answer.role !== "ai") continue;
    const documentGrounded = Boolean(answer.sources?.length || answer.tool || answer.imageUrls?.length);
    const safeToolMemory = answer.toolObservation?.kind === "blob_inventory"
      ? "I answered using the connected wallet's cached Shelby inventory snapshot. If the user asks to confirm, recheck, continue, or list that inventory, call get_wallet_blob_inventory again. If it is stale, call refresh_wallet_blob_inventory once and then reread it. Report fetchedAt honestly and never use document search for that follow-up."
      : null;
    output.push(
      { role: "user", parts: [{ text: user.text.slice(0, 2_000) }] },
      {
        role: "model",
        parts: [{
          text: safeToolMemory ?? (documentGrounded
            ? "I answered this turn with app-provided data. If the user follows up, resolve the subject from their previous question and use the tool to search again; do not rely on the previous answer text."
            : answer.text.slice(0, 4_000)),
        }],
      },
    );
    index += 1;
  }
  return output.slice(-10);
}
