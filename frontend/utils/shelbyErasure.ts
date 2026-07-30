import { ClayErasureCodingProvider, defaultErasureCodingConfig } from "@shelby-protocol/sdk/browser";

let erasureProviderPromise: ReturnType<typeof ClayErasureCodingProvider.create> | null = null;

/** Shared Clay encoder used by uploads and Answer Receipt verification. */
export function getErasureProvider() {
  erasureProviderPromise ??= ClayErasureCodingProvider.create(defaultErasureCodingConfig()).catch((error) => {
    erasureProviderPromise = null;
    throw error;
  });
  return erasureProviderPromise;
}
