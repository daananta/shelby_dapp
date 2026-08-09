import { Network } from "@aptos-labs/ts-sdk";
import { describe, expect, it } from "vitest";
import {
  assertShelbyNetworkAvailable,
  createShelbyWorkspaceKey,
  getShelbyNetworkCapabilities,
  isWalletNetworkMatch,
  isSupportedShelbyNetwork,
  parseShelbyWorkspaceKey,
  resolveOperationalShelbyNetwork,
  toAptosNetwork,
} from "@/utils/shelbyNetwork";

describe("Shelby network identity", () => {
  it("maps each app network to the matching Aptos network", () => {
    expect(toAptosNetwork("shelbynet")).toBe(Network.SHELBYNET);
    expect(toAptosNetwork("testnet")).toBe(Network.TESTNET);
  });

  it("keeps Testnet identity dormant while ShelbyNet is the only operational network", () => {
    expect(getShelbyNetworkCapabilities("shelbynet")).toMatchObject({ availability: "active", canRead: true, canWrite: true, uploadProtocol: "object-v2" });
    expect(getShelbyNetworkCapabilities("testnet")).toMatchObject({ availability: "temporarily_unavailable", canRead: false, canWrite: false, uploadProtocol: "legacy" });
    expect(resolveOperationalShelbyNetwork("testnet")).toBe("shelbynet");
    expect(() => assertShelbyNetworkAvailable("testnet")).toThrow(/temporarily unavailable/i);
  });

  it("isolates the same wallet by network", () => {
    expect(createShelbyWorkspaceKey({ network: "shelbynet", owner: "0xABC" })).toBe("shelbynet:0xabc");
    expect(createShelbyWorkspaceKey({ network: "testnet", owner: "0xABC" })).toBe("testnet:0xabc");
  });

  it("treats legacy owner keys as Testnet without accepting unknown networks", () => {
    expect(parseShelbyWorkspaceKey("0xABC")).toEqual({ network: "testnet", owner: "0xabc" });
    expect(parseShelbyWorkspaceKey("shelbynet:0xABC")).toEqual({ network: "shelbynet", owner: "0xabc" });
    expect(isSupportedShelbyNetwork("mainnet")).toBe(false);
  });

  it("requires the wallet-reported network to match the active workspace", () => {
    expect(isWalletNetworkMatch("shelbynet", "shelbynet")).toBe(true);
    expect(isWalletNetworkMatch("testnet", "shelbynet")).toBe(false);
    expect(isWalletNetworkMatch(undefined, "testnet")).toBe(false);
  });

  it("recognizes Petra's custom ShelbyNet entry by its canonical RPC hostname", () => {
    expect(isWalletNetworkMatch({
      name: Network.CUSTOM,
      chainId: 4,
      url: "https://api.shelbynet.shelby.xyz/v1",
    }, "shelbynet")).toBe(true);
    expect(isWalletNetworkMatch({
      name: Network.CUSTOM,
      url: "api.shelbynet.shelby.xyz/v1",
    }, "shelbynet")).toBe(true);
  });

  it("keeps unknown or lookalike custom RPC networks blocked", () => {
    expect(isWalletNetworkMatch({ name: Network.CUSTOM }, "shelbynet")).toBe(false);
    expect(isWalletNetworkMatch({
      name: Network.CUSTOM,
      url: "https://api.shelbynet.shelby.xyz.evil.example/v1",
    }, "shelbynet")).toBe(false);
    expect(isWalletNetworkMatch({
      name: Network.CUSTOM,
      url: "https://api.testnet.aptoslabs.com/v1",
    }, "shelbynet")).toBe(false);
  });
});
