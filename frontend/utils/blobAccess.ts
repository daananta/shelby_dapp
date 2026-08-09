import { getShelbyBlobUrl } from "@/utils/shelbyConfig";
import { getShelbyClientKeyResult } from "@/utils/geomiClientKey";
import type { AccessPolicyInfo } from "@/utils/accessControl";
import { localize } from "@/i18n";
import { getStoredShelbyNetwork, type SupportedShelbyNetwork } from "@/utils/shelbyNetwork";

/** The access labels understood by the RAG importer and its access broker. */
export type BlobAccessTag = "public" | "allowlist" | "purchasable" | "time_lock";

export interface BlobAccessInfo {
  tag: BlobAccessTag;
  unlockAtMicros?: number;
  allowlist: string[];
  purchasers: string[];
  canAccess?: boolean | null;
  greenBoxScheme?: number;
  greenBoxByteLength?: number;
  /** Access is granted, but the downloaded Shelby bytes still require GreenBox decryption. */
  requiresDecryption?: boolean;
  /** True when the policy came from access_control::query3_bcs. */
  onChain?: boolean;
  /** Query failed or returned a custom policy the RAG importer cannot evaluate. */
  unresolved?: boolean;
}

export interface AccessDecision {
  info: BlobAccessInfo;
  eligible: boolean;
  needsBroker: boolean;
  needsDecryption?: boolean;
  reason?: string;
}

interface BrokerChallenge { challenge: string; nonce?: string; }
interface BrokerGrant { url: string; headers?: Record<string, string>; expiresAtMicros?: number; }

const brokerUrl = (import.meta.env.VITE_RAG_ACCESS_BROKER_URL ?? "").replace(/\/$/, "");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(normalizeAddress).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(normalizeAddress).filter(Boolean);
  return [];
}

function normalizeTag(value: unknown): BlobAccessTag {
  const tag = String(value ?? "public").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["allowlist", "allow_list", "whitelist"].includes(tag)) return "allowlist";
  if (["purchasable", "purchase", "paid"].includes(tag)) return "purchasable";
  if (["time_lock", "timelock", "time_locked", "scheduled"].includes(tag)) return "time_lock";
  return "public";
}

/** Accept Unix seconds, milliseconds, microseconds, or an ISO timestamp. */
export function parseTimestampMicros(value: unknown): number | undefined {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis * 1_000 : undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  if (numeric < 100_000_000_000) return Math.floor(numeric * 1_000_000); // seconds
  if (numeric < 100_000_000_000_000) return Math.floor(numeric * 1_000); // milliseconds
  return Math.floor(numeric); // microseconds
}

/**
 * Shelby's core BlobMetadata intentionally has no access-tag fields. This
 * decoder accepts common extension shapes supplied by an indexer or gateway,
 * without treating an absent tag as a private object.
 */
export function readBlobAccessInfo(blob: unknown): BlobAccessInfo {
  const record = asRecord(blob);
  const onChainPolicy = asRecord(record.accessPolicy) as Partial<AccessPolicyInfo>;
  const onChainType = onChainPolicy.type;
  if (onChainType && onChainType !== "unknown" && onChainType !== "custom") {
    const tag: BlobAccessTag = onChainType === "none" ? "public" : onChainType === "timelock" ? "time_lock" : onChainType === "purchasable" ? "purchasable" : "allowlist";
    return {
      tag,
      unlockAtMicros: parseTimestampMicros(onChainPolicy.lockedUntilMicros),
      allowlist: [],
      purchasers: [],
      canAccess: onChainPolicy.canAccess,
      greenBoxScheme: onChainPolicy.greenBoxScheme,
      greenBoxByteLength: onChainPolicy.greenBoxBytes?.byteLength,
      requiresDecryption: Boolean(onChainPolicy.greenBoxBytes?.byteLength),
      onChain: true,
    };
  }
  if (onChainType === "unknown" || onChainType === "custom") return { tag: "public", allowlist: [], purchasers: [], canAccess: null, onChain: true, unresolved: true };
  const metadata = asRecord(record.metadata);
  const access = asRecord(record.access ?? metadata.access ?? record.accessControl ?? metadata.accessControl);
  const tags = Array.isArray(record.tags) ? record.tags : Array.isArray(metadata.tags) ? metadata.tags : [];
  const tagValue = record.accessTag ?? record.tag ?? metadata.accessTag ?? metadata.tag ?? access.tag ?? tags.find((tag) => typeof tag === "string");
  const timeLock = asRecord(record.timeLock ?? metadata.timeLock ?? access.timeLock);
  const unlockAtMicros = parseTimestampMicros(
    record.unlockAtMicros ?? record.unlockAt ?? record.unlockTime ?? metadata.unlockAtMicros ?? metadata.unlockAt ?? metadata.unlockTime ??
    access.unlockAtMicros ?? access.unlockAt ?? access.unlockTime ?? timeLock.unlockAtMicros ?? timeLock.unlockAt ?? timeLock.unlockTime,
  );
  const allowlist = [...new Set([
    ...toStringList(record.allowlist), ...toStringList(metadata.allowlist), ...toStringList(access.allowlist), ...toStringList(access.addresses),
  ])];
  const purchasers = [...new Set([
    ...toStringList(record.purchasers), ...toStringList(metadata.purchasers), ...toStringList(access.purchasers), ...toStringList(access.purchasedBy),
  ])];
  return { tag: normalizeTag(tagValue), unlockAtMicros, allowlist, purchasers };
}

export function getBlobAccessDecision(blob: unknown, walletAddress?: string, nowMicros = Date.now() * 1_000): AccessDecision {
  const info = readBlobAccessInfo(blob);
  const wallet = normalizeAddress(walletAddress);
  if (info.unresolved) return {
    info,
    eligible: false,
    needsBroker: false,
    reason: localize("Access could not be verified, so this blob was not read.", "Không xác minh được quyền truy cập nên RAG không tải blob này."),
  };
  if (info.onChain && info.tag === "public") return { info, eligible: true, needsBroker: false };
  if (info.tag === "time_lock") {
    if (!info.unlockAtMicros) return {
      info,
      eligible: false,
      needsBroker: false,
      reason: localize("The time lock has no unlock time, so this blob was not read.", "Time lock không có thời điểm mở khoá nên RAG không tải blob này."),
    };
    if (nowMicros < info.unlockAtMicros) return {
      info,
      eligible: false,
      needsBroker: false,
      reason: localize(
        `Unlocks at ${new Date(info.unlockAtMicros / 1_000).toLocaleString("en-US")}.`,
        `Mở khóa lúc ${new Date(info.unlockAtMicros / 1_000).toLocaleString("vi-VN")}.`,
      ),
    };
    if (info.onChain && info.canAccess === false) return {
      info,
      eligible: false,
      needsBroker: false,
      reason: localize("The time lock does not allow access yet.", "Time lock chưa cho phép truy cập."),
    };
    if (info.requiresDecryption) return {
      info,
      eligible: false,
      needsBroker: false,
      needsDecryption: true,
      reason: localize(
        "The time lock is open, but this app does not yet support decrypting its protected data.",
        "Time lock đã mở, nhưng ứng dụng chưa hỗ trợ giải mã lớp bảo vệ của blob này.",
      ),
    };
    return { info, eligible: true, needsBroker: false };
  }
  if (info.onChain && info.canAccess === null) return {
    info,
    eligible: false,
    needsBroker: false,
    reason: localize("On-chain access could not be verified, so this blob was not read.", "Không xác minh được quyền on-chain nên RAG không tải blob này."),
  };
  if (info.onChain && info.canAccess === false) {
    const message = info.tag === "allowlist"
      ? localize("This wallet is not on the blob's allowlist.", "Ví không nằm trong allowlist của blob này.")
      : localize("Purchase access before reading this blob.", "Blob này cần mua quyền truy cập trước.");
    return { info, eligible: false, needsBroker: false, reason: message };
  }
  if (info.requiresDecryption) return {
    info,
    eligible: false,
    needsBroker: false,
    needsDecryption: true,
    reason: localize(
      "Access is granted, but this app does not yet support decrypting this protected blob.",
      "Đã có quyền truy cập, nhưng ứng dụng chưa hỗ trợ giải mã lớp bảo vệ của blob này.",
    ),
  };
  if (info.tag === "public") return { info, eligible: true, needsBroker: false };
  // An unencrypted on-chain policy can be read directly after canAccess passes.
  // GreenBox-protected policies are rejected above until an official decryptor
  // is available; canAccess alone does not turn ciphertext into plaintext.
  if (info.onChain) return { info, eligible: true, needsBroker: false };
  if (!brokerUrl) return {
    info,
    eligible: false,
    needsBroker: true,
    reason: localize(
      `This ${info.tag} access type requires a secure access service that is not configured.`,
      `Loại quyền ${info.tag} cần dịch vụ xác thực an toàn nhưng ứng dụng chưa được cấu hình.`,
    ),
  };
  if (info.tag === "allowlist" && info.allowlist.length && !info.allowlist.includes(wallet)) {
    return { info, eligible: false, needsBroker: true, reason: localize("The connected wallet is not on this blob's allowlist.", "Ví đang kết nối không nằm trong allowlist của blob này.") };
  }
  if (info.tag === "purchasable" && info.purchasers.length && !info.purchasers.includes(wallet)) {
    return { info, eligible: false, needsBroker: true, reason: localize("This wallet does not have a purchase receipt for the blob.", "Ví chưa có biên lai mua blob này.") };
  }
  return { info, eligible: true, needsBroker: true };
}

/** The standard RAG queue deliberately excludes allowlist and purchasable blobs. */
export function isRagSourceEligible(blob: unknown, walletAddress?: string, nowMicros = Date.now() * 1_000): boolean {
  const record = asRecord(blob);
  if (record.isWritten === false || record.isDeleted === true) return false;
  const expirationMicros = parseTimestampMicros(record.expirationMicros);
  if (expirationMicros !== undefined && expirationMicros <= nowMicros) return false;
  const decision = getBlobAccessDecision(blob, walletAddress, nowMicros);
  return decision.eligible && (decision.info.tag === "public" || decision.info.tag === "time_lock");
}

async function signedBrokerGrant(owner: string, blobName: string, walletAddress: string, tag: BlobAccessTag, network: SupportedShelbyNetwork, signMessage: (input: any) => Promise<unknown>, signal?: AbortSignal): Promise<BrokerGrant> {
  const challengeResponse = await fetch(`${brokerUrl}/v1/rag-access/challenge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ network, owner, blobName, walletAddress, tag }), signal,
  });
  if (!challengeResponse.ok) throw new Error(localize(`The secure access service could not start verification (${challengeResponse.status}).`, `Dịch vụ xác thực không thể bắt đầu kiểm tra (${challengeResponse.status}).`));
  const challenge = await challengeResponse.json() as BrokerChallenge;
  if (!challenge.challenge) throw new Error(localize("The secure access service returned an invalid request.", "Dịch vụ xác thực trả về yêu cầu không hợp lệ."));
  signal?.throwIfAborted();
  const signature = await signMessage({ message: challenge.challenge, nonce: challenge.nonce ?? "shelby-rag-access", application: "Shelby RAG Explorer" });
  signal?.throwIfAborted();
  const grantResponse = await fetch(`${brokerUrl}/v1/rag-access/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ network, owner, blobName, walletAddress, tag, challenge, signature }), signal,
  });
  if (!grantResponse.ok) throw new Error(localize(
    `Access was denied (${grantResponse.status}). Check the allowlist or purchase receipt.`,
    `Quyền truy cập bị từ chối (${grantResponse.status}). Hãy kiểm tra allowlist hoặc biên lai mua.`,
  ));
  const grant = await grantResponse.json() as BrokerGrant;
  if (!grant.url) throw new Error(localize("The secure access service did not return a valid download link.", "Dịch vụ xác thực không trả về liên kết tải hợp lệ."));
  if (grant.expiresAtMicros && grant.expiresAtMicros <= Date.now() * 1_000) throw new Error(localize("The access link has expired; build RAG again.", "Liên kết truy cập đã hết hạn; hãy tạo lại RAG."));
  return grant;
}

export interface RagBlobDownload {
  url: string;
  content: Blob;
  blobUrl?: string;
  dispose: () => void;
}

/**
 * Downloads a blob into a short-lived object URL. Restricted blobs never leave
 * a bearer URL in IndexedDB or the chat transcript; only public blobs retain a
 * clickable source link.
 */
export async function downloadBlobForRag(params: {
  owner: string;
  blobName: string;
  blob: unknown;
  walletAddress: string;
  signMessage: (input: any) => Promise<unknown>;
  maxBytes?: number;
  signal?: AbortSignal;
  network?: SupportedShelbyNetwork;
}): Promise<RagBlobDownload> {
  params.signal?.throwIfAborted();
  const record = asRecord(params.blob);
  if (record.isDeleted === true) throw new Error(localize("The blob was deleted from Shelby.", "Blob đã bị xoá khỏi Shelby."));
  if (record.isWritten === false) throw new Error(localize("The blob is registered, but its data has not finished uploading to Shelby.", "Blob đã đăng ký nhưng dữ liệu chưa được tải hoàn tất lên Shelby."));
  const expirationMicros = parseTimestampMicros(record.expirationMicros);
  if (expirationMicros !== undefined && expirationMicros <= Date.now() * 1_000) throw new Error(localize("The blob has expired on Shelby.", "Blob trên Shelby đã hết hạn."));
  const decision = getBlobAccessDecision(params.blob, params.walletAddress);
  if (!decision.eligible) throw new Error(decision.reason ?? localize("The blob is not available to this wallet.", "Blob chưa đủ điều kiện truy cập."));
  const maxBytes = params.maxBytes ?? 25 * 1024 * 1024;
  const sizeLimitError = () => localize(
    `The blob exceeds the safe ${Math.floor(maxBytes / 1024 / 1024)} MB download limit.`,
    `Blob vượt giới hạn tải an toàn ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
  );
  if (Number(record.size ?? 0) > maxBytes) throw new Error(sizeLimitError());
  if (typeof record.mockContent === "string") {
    const content = new Blob([record.mockContent], { type: String(asRecord(record.metadata).contentType ?? "application/json") });
    if (content.size > maxBytes) throw new Error(sizeLimitError());
    const url = URL.createObjectURL(content);
    return { url, content, dispose: () => URL.revokeObjectURL(url) };
  }
  const network = params.network ?? getStoredShelbyNetwork();
  const clientKey = getShelbyClientKeyResult(network).key;
  const grant = decision.needsBroker
    ? await signedBrokerGrant(params.owner, params.blobName, params.walletAddress, decision.info.tag, network, params.signMessage, params.signal)
    : {
        url: getShelbyBlobUrl(params.owner, params.blobName, network),
        headers: clientKey
          ? { Authorization: `Bearer ${clientKey}` }
          : undefined,
      };
  // The SDK's current getBlob API cannot receive an AbortSignal. This equivalent
  // authenticated streaming read keeps Stop/wallet changes cancellable.
  const response = await fetch(grant.url, { headers: grant.headers, signal: params.signal });
  if (!response.ok) throw new Error(localize(`Unable to download the blob (${response.status}).`, `Không thể tải blob (${response.status}).`));
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (declaredBytes > maxBytes) throw new Error(sizeLimitError());
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  let readable = response.body;
  if (!readable) {
    const fallback = await response.blob();
    if (fallback.size > maxBytes) throw new Error(sizeLimitError());
    readable = fallback.stream();
  }
  const chunks: ArrayBuffer[] = [];
  let receivedBytes = 0;
  if (readable) {
    const reader = readable.getReader();
    const abortReader = () => { void reader.cancel(params.signal?.reason).catch(() => undefined); };
    params.signal?.addEventListener("abort", abortReader, { once: true });
    try {
      let streamDone = false;
      while (!streamDone) {
        params.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        streamDone = done;
        if (done) continue;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) throw new Error(sizeLimitError());
        chunks.push(new Uint8Array(value).buffer as ArrayBuffer);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      params.signal?.removeEventListener("abort", abortReader);
    }
  }
  if (declaredBytes > 0 && receivedBytes !== declaredBytes) {
    throw new Error(localize(
      `The Shelby response ended early (${receivedBytes}/${declaredBytes} bytes).`,
      `Dữ liệu Shelby kết thúc sớm (${receivedBytes}/${declaredBytes} byte).`,
    ));
  }
  const content = new Blob(chunks, { type: contentType });
  const url = URL.createObjectURL(content);
  return { url, content, blobUrl: decision.info.tag === "public" ? getShelbyBlobUrl(params.owner, params.blobName, network) : undefined, dispose: () => URL.revokeObjectURL(url) };
}
