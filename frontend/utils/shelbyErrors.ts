import type { AppLanguage } from "@/i18n";
import type { GeomiClientKeyIssue } from "@/utils/geomiClientKey";

export type ShelbyServiceErrorKind = "configuration" | "authentication" | "rate_limit" | "server" | "network" | "unknown";

export class ShelbyClientConfigurationError extends Error {
  constructor(readonly issue: Exclude<GeomiClientKeyIssue, null>) {
    super(`Shelby client configuration is ${issue}`);
    this.name = "ShelbyClientConfigurationError";
  }
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; response?: { status?: unknown } };
  const status = value.status ?? value.response?.status;
  return typeof status === "number" ? status : undefined;
}

export function classifyShelbyServiceError(error: unknown): ShelbyServiceErrorKind {
  if (error instanceof ShelbyClientConfigurationError) return "configuration";
  const status = errorStatus(error);
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.toLowerCase();
  if (status === 429 || /\b429\b|rate.?limit|too many requests/.test(message)) return "rate_limit";
  if (status === 401 || status === 403 || /unauthorized|anonymous requests are not allowed|authentication|authorization.*bearer/.test(message)) return "authentication";
  if ((status !== undefined && status >= 500 && status <= 599) || /(?:^|\D)5\d{2}(?:\D|$)/.test(message)) return "server";
  if (/failed to fetch|network|load failed|fetch failed|timeout|timed out/.test(message)) return "network";
  return "unknown";
}

/** Inventory retries only transient transport failures and upstream 5xx responses. */
export function isRetriableShelbyServiceError(error: unknown): boolean {
  const kind = classifyShelbyServiceError(error);
  return kind === "network" || kind === "server";
}

export function getShelbyRefreshErrorCopy(kind: ShelbyServiceErrorKind, language: AppLanguage) {
  const copy = {
    configuration: {
      en: {
        title: "Shelby is not connected yet",
        description: "This deployment cannot open your Shelby library. This is not a wallet problem; your blobs and on-device knowledge base were not changed.",
      },
      vi: {
        title: "Ứng dụng chưa kết nối được Shelby",
        description: "Bản triển khai này chưa mở được thư viện Shelby. Đây không phải lỗi ví; blob và kho tri thức trên máy của bạn không bị thay đổi.",
      },
    },
    authentication: {
      en: {
        title: "Shelby connection is unavailable",
        description: "The app could not authenticate with Shelby. This is not a wallet problem; your blobs and on-device knowledge base were not changed.",
      },
      vi: {
        title: "Kết nối Shelby chưa khả dụng",
        description: "Ứng dụng chưa xác thực được với Shelby. Đây không phải lỗi ví; blob và kho tri thức trên máy của bạn không bị thay đổi.",
      },
    },
    rate_limit: {
      en: {
        title: "Shelby is busy",
        description: "Too many requests were sent. Wait a moment, then refresh; your existing data is unchanged.",
      },
      vi: {
        title: "Shelby đang bận",
        description: "Đã có quá nhiều yêu cầu. Hãy chờ một lúc rồi làm mới; dữ liệu hiện có của bạn không bị thay đổi.",
      },
    },
    server: {
      en: {
        title: "Shelby is temporarily unavailable",
        description: "The Shelby service returned an error. Wait a moment, then refresh; your existing data is unchanged.",
      },
      vi: {
        title: "Shelby tạm thời chưa khả dụng",
        description: "Dịch vụ Shelby đang trả về lỗi. Hãy chờ một lúc rồi làm mới; dữ liệu hiện có của bạn không bị thay đổi.",
      },
    },
    network: {
      en: {
        title: "Could not reach Shelby",
        description: "Check your connection and try again. The last successfully loaded data remains available.",
      },
      vi: {
        title: "Không thể kết nối Shelby",
        description: "Hãy kiểm tra mạng rồi thử lại. Dữ liệu tải thành công gần nhất vẫn được giữ nguyên.",
      },
    },
    unknown: {
      en: {
        title: "Could not refresh Shelby",
        description: "Shelby did not return usable data. Try again later; your existing data was not removed.",
      },
      vi: {
        title: "Không thể làm mới Shelby",
        description: "Shelby chưa trả về dữ liệu dùng được. Hãy thử lại sau; dữ liệu hiện có không bị xóa.",
      },
    },
  } satisfies Record<ShelbyServiceErrorKind, Record<AppLanguage, { title: string; description: string }>>;
  return copy[kind][language];
}

/** Safe for production logs: intentionally excludes message, request, headers and variables. */
export function getShelbyErrorDiagnostic(error: unknown) {
  return {
    kind: classifyShelbyServiceError(error),
    status: errorStatus(error),
    name: error instanceof Error ? error.name : typeof error,
  };
}
