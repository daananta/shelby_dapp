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
    network?: "shelbynet" | "testnet";
  };
  imageUrls?: string[];
  referencedSources?: string[];
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
 * Recent user-visible conversation for the adaptive agent. Raw source records,
 * tool payloads and orchestration metadata stay out of model history. Keeping
 * the final visible answer lets the model resolve natural follow-ups, while a
 * tool is still required for any user-specific fact that answer did not state.
 */
export function buildAdaptiveGeminiHistory(messages: MemoryMessage[]) {
  const output: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index];
    const answer = messages[index + 1];
    if (user.role !== "user" || answer.role !== "ai") continue;
    const imageSources = answer.imageUrls?.length
      ? [...new Set((answer.referencedSources ?? []).filter((source) => typeof source === "string" && source.trim()))]
        .slice(0, 3)
      : [];
    const safeImageMemory = imageSources.length
      ? `I previously answered using ${imageSources.length === 1 ? "the indexed image" : "the indexed images"} ${imageSources.map((source) => JSON.stringify(source)).join(", ")}. ${answer.text.slice(0, 4_000)}`
      : null;
    output.push(
      { role: "user", parts: [{ text: user.text.slice(0, 2_000) }] },
      {
        role: "model",
        parts: [{
          text: safeImageMemory ?? answer.text.slice(0, 4_000),
        }],
      },
    );
    index += 1;
  }
  return output.slice(-10);
}
