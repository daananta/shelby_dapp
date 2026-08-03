import { describe, expect, it, vi } from "vitest";
import {
  availableAgentToolNames,
  createAgentToolRegistry,
  requiredObservationPlan,
} from "@/utils/agentRuntime";

describe("provider-neutral agent runtime", () => {
  it("requires a wallet observation but leaves the detail argument to the model", () => {
    const available = [
      "search_user_knowledge",
      "get_wallet_blob_inventory",
      "get_connected_wallet",
    ] as const;

    expect(requiredObservationPlan("địa chỉ ví của tôi là gì", available))
      .toEqual([["get_connected_wallet"]]);
    expect(requiredObservationPlan("Explain how an Aptos wallet works", available))
      .toEqual([]);
    expect(requiredObservationPlan("Tôi có những blob nào?", [
      ...available,
      "inspect_application",
    ])).toEqual([["get_wallet_blob_inventory"]]);
    expect(requiredObservationPlan("How many pages does a typical book have?", available)).toEqual([]);
    expect(requiredObservationPlan("Open package.json and identify the main libraries used.", [
      ...available,
      "inspect_application",
    ])).toEqual([["search_user_knowledge"]]);
    expect(requiredObservationPlan("Which indexed image blobs are available?", [
      ...available,
      "inspect_application",
      "analyze_indexed_image",
    ])).toEqual([["inspect_application"]]);
    expect(requiredObservationPlan("Describe what is visible in this image.", [
      ...available,
      "inspect_application",
      "analyze_indexed_image",
    ])).toEqual([["analyze_indexed_image"]]);
    expect(requiredObservationPlan("Which visible details support that description?", [
      ...available,
      "inspect_application",
      "analyze_indexed_image",
    ])).toEqual([["analyze_indexed_image"]]);
    expect(requiredObservationPlan("Refresh my wallet blob count right now", [
      ...available,
      "refresh_wallet_blob_inventory",
    ])).toEqual([
      ["refresh_wallet_blob_inventory"],
      ["get_wallet_blob_inventory"],
    ]);
  });

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
});
