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
    const adaptive = buildAdaptiveAgentSystemInstruction({ activeNetwork: "shelbynet" });
    expect(adaptive).toContain("knowledge-search tool only when");
    expect(adaptive).toContain("ordinary questions");
    expect(adaptive).toContain("Never mention policy files");
    expect(adaptive).toContain("get_wallet_blob_inventory");
    expect(adaptive).toContain("refresh_wallet_blob_inventory");
    expect(adaptive).toContain("get_connected_wallet");
    expect(adaptive).toContain("inspect_application");
    expect(adaptive).toContain("stored vision description");
    expect(adaptive).toContain("up to 3");
    expect(adaptive).toContain("Active Shelby network: ShelbyNet (shelbynet)");
    expect(adaptive).toContain("Every available tool is scoped to this active network only");
    expect(adaptive).toContain("Preserved artifacts from another network are isolated archives");
    expect(adaptive).not.toContain("[S1]");
  });

  it("changes the authoritative runtime context with the selected network", () => {
    const testnet = buildAdaptiveAgentSystemInstruction({ activeNetwork: "testnet" });
    expect(testnet).toContain("Active Shelby network: Shelby Testnet (testnet)");
    expect(testnet).toContain("Network availability: temporarily_unavailable; reads: disabled; writes: disabled");
    expect(testnet).not.toContain("Active Shelby network: ShelbyNet (shelbynet)");
  });
});
