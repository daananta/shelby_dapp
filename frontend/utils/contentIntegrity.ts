export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeHex(value?: string | Uint8Array | number[] | null): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value.replace(/^0x/i, "").toLowerCase();
  return bytesToHex(value instanceof Uint8Array ? value : Uint8Array.from(value));
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${bytesToHex(new Uint8Array(digest))}`;
}
