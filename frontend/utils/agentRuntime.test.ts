import { describe, expect, it, vi } from "vitest";
import {
  availableAgentToolNames,
  createAgentToolRegistry,
  explicitShelbyNetworkTargets,
} from "@/utils/agentRuntime";

describe("provider-neutral agent runtime", () => {
  it("advertises only handlers that the current browser turn can execute", () => {
    const registry = createAgentToolRegistry({
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: vi.fn(),
      getConnectedWallet: vi.fn(),
    }, "latest question");

    expect(availableAgentToolNames(registry)).toEqual([
      "search_user_knowledge",
      "get_wallet_blob_inventory",
      "get_connected_wallet",
    ]);
    expect(registry.has("inspect_application")).toBe(false);
    expect(registry.has("analyze_indexed_image")).toBe(false);
  });

  it("recognizes explicit network identities without classifying ordinary language", () => {
    expect(explicitShelbyNetworkTargets("Show my ShelbyNet blobs")).toEqual(["shelbynet"]);
    expect(explicitShelbyNetworkTargets("Compare ShelbyNet with Shelby Testnet")).toEqual(["shelbynet", "testnet"]);
    expect(explicitShelbyNetworkTargets("Explain decentralized storage")).toEqual([]);
  });

  it("pins tool execution and provenance to the active network", async () => {
    const inventory = vi.fn(async () => ({ ok: true, count: 4 }));
    const activeRegistry = createAgentToolRegistry({
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: inventory,
    }, "How many blobs are on ShelbyNet?", "shelbynet");

    await expect(activeRegistry.get("get_wallet_blob_inventory")!.execute({ detail: "count" }))
      .resolves.toMatchObject({ ok: true, count: 4, network: "shelbynet" });
    expect(inventory).toHaveBeenCalledOnce();

    const comparisonRegistry = createAgentToolRegistry({
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: inventory,
    }, "Compare the blobs I have on ShelbyNet and Testnet", "shelbynet");
    await expect(comparisonRegistry.get("get_wallet_blob_inventory")!.execute({ detail: "count" }))
      .resolves.toMatchObject({ ok: true, count: 4, network: "shelbynet" });
    expect(inventory).toHaveBeenCalledTimes(2);

    const wrongProvenanceRegistry = createAgentToolRegistry({
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: vi.fn(async () => ({ ok: true, count: 7, network: "testnet" })),
    }, "How many blobs are on ShelbyNet?", "shelbynet");
    await expect(wrongProvenanceRegistry.get("get_wallet_blob_inventory")!.execute({ detail: "count" }))
      .resolves.toMatchObject({
        ok: false,
        code: "tool_network_mismatch",
        activeNetwork: "shelbynet",
        observedNetwork: "testnet",
      });

    const mismatchedRegistry = createAgentToolRegistry({
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: inventory,
    }, "How many blobs are on Testnet?", "shelbynet");
    await expect(mismatchedRegistry.get("get_wallet_blob_inventory")!.execute({ detail: "count" }))
      .resolves.toMatchObject({
        ok: false,
        code: "network_scope_mismatch",
        activeNetwork: "shelbynet",
        requestedNetworks: ["testnet"],
      });
    expect(inventory).toHaveBeenCalledTimes(2);
  });
});
