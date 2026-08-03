import { describe, expect, it } from "vitest";
import { buildAdaptiveAgentSystemInstruction, buildAgentSystemInstruction } from "@/utils/agentPolicy";

describe("agent policy isolation", () => {
  it("injects durable behavior and a scoped skill without injecting RAG evidence", () => {
    const general = buildAgentSystemInstruction("general");
    const document = buildAgentSystemInstruction("document_semantic");
    expect(general).toContain("RAG is an isolated memory module");
    expect(general).toContain("general facts");
    expect(document).toContain("supplied document evidence");
    expect(document).not.toContain("sach.pdf");
  });

  it("lets Cloud AI choose document search without exposing internal policy files", () => {
    const adaptive = buildAdaptiveAgentSystemInstruction();
    expect(adaptive).toContain("knowledge-search tool only when");
    expect(adaptive).toContain("ordinary questions");
    expect(adaptive).toContain("Never mention policy files");
    expect(adaptive).toContain("get_wallet_blob_inventory");
    expect(adaptive).toContain("refresh_wallet_blob_inventory");
    expect(adaptive).toContain("get_connected_wallet");
    expect(adaptive).toContain("inspect_application");
    expect(adaptive).toContain("stored vision description");
    expect(adaptive).toContain("up to 3");
    expect(adaptive).not.toContain("[S1]");
  });
});
