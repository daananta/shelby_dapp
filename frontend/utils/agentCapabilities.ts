import type { BlobInventoryDetail } from "@/utils/chatTools";

export interface RefreshedBlobInventory {
  status: "refreshed" | "unavailable";
  count?: number;
  examples?: string[];
  names?: string[];
  truncated?: boolean;
  fetchedAt?: number;
  source?: "shelby" | "demo";
  code?: string;
}

export type BlobInventoryRefreshCapability = (
  detail: BlobInventoryDetail,
  signal?: AbortSignal,
) => Promise<RefreshedBlobInventory>;

export type RegisterBlobInventoryRefresh = (
  capability: BlobInventoryRefreshCapability,
) => () => void;

export function unavailableBlobInventoryRefresh(code = "refresh_capability_unavailable"): RefreshedBlobInventory {
  return { status: "unavailable", code };
}
