import { useState, useEffect, useRef } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { AccountAddress } from "@aptos-labs/ts-sdk";
import { BlobNameSchema, ShelbyBlobClient, generateCommitments, requiredAckCount } from "@shelby-protocol/sdk/browser";
import { getUseAccountBlobsQueryKey, useAccountBlobs } from "@shelby-protocol/react";
import { useQueryClient } from "@tanstack/react-query";
import { getShelbyRuntime } from "@/utils/shelbyConfig";
import { isBlockingGeomiClientKeyIssue } from "@/utils/geomiClientKey";
import { useToast } from "@/components/ui/use-toast";
import { accessPolicyQueryKey, queryAccessPolicies } from "@/utils/accessControl";
import { isRagSourceEligible } from "@/utils/blobAccess";
import { getShelbyBlobInventory, invalidateShelbyBlobInventory, setShelbyBlobInventory, setActiveRagOwner } from "@/utils/ragOrama";
import { isE2EShelbyConfigurationError, isE2EWalletConnected, isMockWorkspace } from "@/utils/devMode";
import { bytesToHex } from "@/utils/contentIntegrity";
import { getErasureProvider } from "@/utils/shelbyErasure";
import { currentLanguage, localize } from "@/i18n";
import { unavailableBlobInventoryRefresh, type BlobInventoryRefreshCapability } from "@/utils/agentCapabilities";
import {
  classifyShelbyServiceError,
  getShelbyErrorDiagnostic,
  getShelbyRefreshErrorCopy,
  isRetriableShelbyServiceError,
  ShelbyClientConfigurationError,
  type ShelbyServiceErrorKind,
} from "@/utils/shelbyErrors";
import { useShelbyNetwork, useShelbyNetworkOperation } from "@/network/ShelbyNetworkProvider";
import { useWalletNetworkReady } from "@/hooks/useWalletNetworkReady";
import { createShelbyWorkspaceKey, ShelbyNetworkUnavailableError, toAptosNetwork } from "@/utils/shelbyNetwork";
import { findMatchingUploadJournal, loadUploadJournal, removeUploadJournal, upsertUploadJournal, type UploadJournalRecord } from "@/utils/uploadJournal";
import { objectCommitFailure, resolveRegisteredBlobUids, uniqueStorageProviderAckCount } from "@/utils/shelbyUploadProtocol";

const MOCK_ACCOUNT = { address: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" };
const YEAR_IN_MICROSECONDS = 365 * 24 * 60 * 60 * 1_000_000;
const MAX_MOCK_UPLOAD_BYTES = 3 * 1024 * 1024;
// Stable demo metadata prevents every refresh from looking like a new blob revision.
const MOCK_DEMO_CREATION_MICROS = 1_900_000_000_000_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)));
  }
  return btoa(binary);
}

export interface ShelbyUploadProgress {
  phase: "commitments" | "registering" | "confirming" | "uploading" | "committing" | "done";
  fileName?: string;
  completedBytes: number;
  totalBytes: number;
}

export function useShelby() {
  const { account: realAccount, signAndSubmitTransaction, signMessage } = useWallet();
  const { network, capabilities } = useShelbyNetwork();
  const walletNetworkReady = useWalletNetworkReady();
  const runtime = getShelbyRuntime(network);
  const clientKeyBlocksRequests = isBlockingGeomiClientKeyIssue(runtime.clientKeyIssue);
  const forceConfigurationError = isE2EShelbyConfigurationError();
  const queryClient = useQueryClient();
  const mockWorkspace = isMockWorkspace();
  const account = isE2EWalletConnected()
    ? MOCK_ACCOUNT
    : realAccount;
  const { toast } = useToast();
  const isSandboxMode = mockWorkspace;

  const [blobs, setBlobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ShelbyUploadProgress | null>(null);
  const [selectedBlobNames, setSelectedBlobNames] = useState<string[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<ShelbyServiceErrorKind | null>(null);
  useShelbyNetworkOperation("shelby-upload", uploading);
  const fetchGenerationRef = useRef(0);
  const uploadInFlightRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const activeUploadAuthorityRef = useRef("");
  const knownEligibleNamesRef = useRef<{ owner: string; names: Set<string> }>({ owner: "", names: new Set() });
  const ownerKey = account?.address?.toString().toLowerCase() ?? "";
  const authorityKey = ownerKey ? createShelbyWorkspaceKey({ network, owner: ownerKey }) : "";
  const currentOwnerRef = useRef(ownerKey);
  const currentAuthorityRef = useRef(authorityKey);
  const walletNetworkReadyRef = useRef(walletNetworkReady);
  currentOwnerRef.current = ownerKey;
  currentAuthorityRef.current = authorityKey;
  walletNetworkReadyRef.current = walletNetworkReady;

  useEffect(() => {
    const abortForNetworkChange = () => uploadAbortRef.current?.abort(new DOMException(
      localize("The Shelby network changed; upload stopped.", "Mạng Shelby đã thay đổi; upload đã dừng."),
      "AbortError",
    ));
    window.addEventListener("shelby:network-changing", abortForNetworkChange);
    return () => window.removeEventListener("shelby:network-changing", abortForNetworkChange);
  }, []);

  useEffect(() => {
    if (!uploadInFlightRef.current) return;
    if (activeUploadAuthorityRef.current !== authorityKey || (!mockWorkspace && !walletNetworkReady)) {
      uploadAbortRef.current?.abort(new DOMException(
        localize("The wallet or network changed; upload stopped.", "Ví hoặc mạng đã thay đổi; upload đã dừng."),
        "AbortError",
      ));
    }
  }, [authorityKey, mockWorkspace, walletNetworkReady]);

  const accountBlobsQuery = useAccountBlobs({
    client: runtime.client,
    account: ownerKey || "0x0",
    enabled: Boolean(capabilities.canRead && ownerKey && walletNetworkReady && !mockWorkspace && !clientKeyBlocksRequests && !forceConfigurationError),
    staleTime: 10_000,
    retry: (failureCount, error) => failureCount < 1 && isRetriableShelbyServiceError(error),
  });

  const [mockBalance, setMockBalance] = useState<number>(() => {
    if (!isSandboxMode) return 0;
    try { return Number(localStorage.getItem("mock_shelby_usd") ?? "100"); } catch { return 100; }
  });
  const [mockPurchasedBlobNames, setMockPurchasedBlobNames] = useState<string[]>(() => {
    if (!isSandboxMode) return [];
    try {
      const value = JSON.parse(localStorage.getItem("mock_purchased_blobs") ?? "[]");
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  });

  const adjustMockBalance = (amount: number) => {
    if (!isSandboxMode) return;
    setMockBalance((prev) => {
      const next = Math.max(0, prev + amount);
      try { localStorage.setItem("mock_shelby_usd", String(next)); } catch { /* sandbox balance remains in memory */ }
      return next;
    });
  };

  const getBlobName = (blob: any) => blob.blobNameSuffix ?? blob.name;

  const getModifiedBlobForRag = (blob: any) => {
    const name = getBlobName(blob);
    return mockPurchasedBlobNames.includes(name)
      ? { ...blob, accessPolicy: { ...blob.accessPolicy, canAccess: true } }
      : blob;
  };

  const isPurchasableAndLocked = (blob: any) => {
    const name = getBlobName(blob);
    if (mockPurchasedBlobNames.includes(name)) return false;
    const policy = blob.accessPolicy;
    return policy?.type === "purchasable" && policy.canAccess === false;
  };

  const handlePurchaseAccess = async (blob: any) => {
    if (!account || !isSandboxMode || !isPurchasableAndLocked(blob)) return;
    const blobName = getBlobName(blob);
    const price = Number(blob.accessPolicy.price ?? 0) / 100_000_000;

    if (mockBalance >= price) {
      adjustMockBalance(-price);
      const nextPurchased = [...mockPurchasedBlobNames, blobName];
      setMockPurchasedBlobNames(nextPurchased);
      try { localStorage.setItem("mock_purchased_blobs", JSON.stringify(nextPurchased)); } catch { /* sandbox access remains in memory */ }
      toast({
        title: localize("✓ Access purchased (Sandbox)", "✓ Đã mua quyền truy cập (Sandbox)"),
        description: localize(
          `Paid ${price} virtual ShelbyUSD. The file is now unlocked on this device.`,
          `Đã thanh toán ${price} ShelbyUSD ảo. Tệp đã được mở khóa trên thiết bị.`,
        ),
      });
      return;
    }

    toast({
      title: localize("✕ Not enough Sandbox balance", "✕ Không đủ số dư Sandbox"),
      description: localize(
        `This requires ${price} ShelbyUSD, but your balance is ${mockBalance} USD.`,
        `Cần ${price} ShelbyUSD nhưng số dư của bạn chỉ có ${mockBalance} USD.`,
      ),
      variant: "destructive"
    });
  };

  const fetchBlobs = async (signal?: AbortSignal): Promise<any[]> => {
    signal?.throwIfAborted();
    if (!capabilities.canRead) throw new ShelbyNetworkUnavailableError(network);
    if (!account || (!walletNetworkReadyRef.current && !mockWorkspace)) return [];
    const requestGeneration = ++fetchGenerationRef.current;
    const ownerAddress = account.address.toString();
    const normalizedOwner = ownerAddress.toLowerCase();
    const requestAuthority = createShelbyWorkspaceKey({ network, owner: normalizedOwner });
    const isCurrentGeneration = () => requestGeneration === fetchGenerationRef.current
      && currentOwnerRef.current === normalizedOwner
      && currentAuthorityRef.current === requestAuthority
      && walletNetworkReadyRef.current;
    const isCurrentRequest = () => isCurrentGeneration() && !signal?.aborted;
    signal?.addEventListener("abort", () => {
      if (isCurrentGeneration()) setLoading(false);
    }, { once: true });
    const mockUploadKey = `shelby-rag-explorer.mock-uploads:${ownerAddress.toLowerCase()}`;
    const mockUploadedBlobs = mockWorkspace ? (() => {
      try {
        const value = JSON.parse(sessionStorage.getItem(mockUploadKey) ?? "[]");
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    })() : [];
    const demoBlobs = isSandboxMode ? [
      {
        owner: ownerAddress,
        blobId: "demo-public-blob",
        blobNameSuffix: "HuongDan_Shelby_RAG.txt",
        isDemoBlob: true,
        demoText: "Đây là tài liệu hướng dẫn sử dụng Shelby RAG Explorer công khai. Hệ thống này kết nối mạng lưu trữ phi tập trung Shelby với AI thế hệ mới để hỗ trợ truy vấn thông tin ngữ cảnh thời gian thực nhanh chóng và bảo mật.",
        creationMicros: MOCK_DEMO_CREATION_MICROS,
        expirationMicros: MOCK_DEMO_CREATION_MICROS + YEAR_IN_MICROSECONDS,
        size: 512,
        isWritten: true,
        isDeleted: false,
        accessPolicy: {
          type: "none",
          canAccess: true
        },
        metadata: {
          name: "HuongDan_Shelby_RAG.txt",
          displayName: "Hướng dẫn Shelby RAG (Public)",
          size: 512
        }
      },
      {
        owner: ownerAddress,
        blobId: "demo-purchasable-blob",
        blobNameSuffix: "KeHoach_Shelby_2026.txt",
        isDemoBlob: true,
        demoText: "Chúc mừng bạn đã mua quyền truy cập thành công! Đây là nội dung tài liệu mật về Kế hoạch phát triển Shelby Protocol năm 2026. Chúng tôi đặt mục tiêu nâng cấp clay codes lên phiên bản mới và mở rộng băng thông RPC lên gấp 10 lần.",
        creationMicros: MOCK_DEMO_CREATION_MICROS,
        expirationMicros: MOCK_DEMO_CREATION_MICROS + YEAR_IN_MICROSECONDS,
        size: 1024,
        isWritten: true,
        isDeleted: false,
        accessPolicy: {
          type: "purchasable",
          price: "5000000000",
          canAccess: false
        },
        metadata: {
          name: "KeHoach_Shelby_2026.txt",
          displayName: "Kế hoạch Shelby 2026 (Locked - 50 ShelbyUSD)",
          size: 1024
        }
      }
    ] : [];
    const sandboxBlobs = [...mockUploadedBlobs, ...demoBlobs];
    const reconcileSelection = (eligibleNames: string[]) => {
      const previousInventory = knownEligibleNamesRef.current;
      const firstInventoryForOwner = previousInventory.owner !== requestAuthority;
      const eligible = new Set(eligibleNames);
      const newlyDiscovered = firstInventoryForOwner ? eligibleNames : eligibleNames.filter((name) => !previousInventory.names.has(name));
      knownEligibleNamesRef.current = { owner: requestAuthority, names: eligible };
      setSelectedBlobNames((previous) => firstInventoryForOwner
        ? eligibleNames
        : [...new Set([...previous.filter((name) => eligible.has(name)), ...newlyDiscovered])]);
    };

    if (mockWorkspace) {
      setLoadError(null);
      const activated = await setActiveRagOwner(requestAuthority, isCurrentRequest);
      if (!activated) return [];
      if (!isCurrentRequest()) return [];
      const names = sandboxBlobs.map((blob: any) => getBlobName(blob));
      const ragEligibleNames = sandboxBlobs.map(getModifiedBlobForRag).filter((blob: any) => isRagSourceEligible(blob, ownerAddress)).map((blob: any) => getBlobName(blob));
      await setShelbyBlobInventory(requestAuthority, names, ragEligibleNames, [], isCurrentRequest);
      if (!isCurrentRequest()) return [];
      setBlobs(sandboxBlobs);
      reconcileSelection(ragEligibleNames);
      setLastSyncedAt(Date.now());
      setLoading(false);
      return sandboxBlobs;
    }

    let data: any[] = [];
    let enrichedData: any[] = [];
    try {
      setLoading(true);
      setLoadError(null);
      const activated = await setActiveRagOwner(requestAuthority, isCurrentRequest);
      if (!activated) return [];
      if (!isCurrentRequest()) return [];
      const clientKeyIssue = forceConfigurationError
        ? "unsafe_key_type"
        : clientKeyBlocksRequests ? runtime.clientKeyIssue : null;
      if (clientKeyIssue) {
        throw new ShelbyClientConfigurationError(clientKeyIssue);
      }
      const queryResult = await accountBlobsQuery.refetch({ cancelRefetch: true });
      if (queryResult.error) throw queryResult.error;
      data = queryResult.data ?? [];
      if (!isCurrentRequest()) return [];
      const accessNames = data.map((blob: any) => getBlobName(blob));
      const accessSnapshot = await queryClient.fetchQuery({
        queryKey: accessPolicyQueryKey(network, ownerAddress, accessNames),
        queryFn: ({ signal: querySignal }) => queryAccessPolicies(
          ownerAddress,
          accessNames,
          signal ?? querySignal,
          network,
        ),
        staleTime: 0,
        retry: false,
      });
      signal?.throwIfAborted();
      enrichedData = data.map((blob: any) => ({ ...blob, accessPolicy: accessSnapshot.policies.get(getBlobName(blob)) ?? { type: "unknown", canAccess: null } }));
      const finalData = [...enrichedData, ...sandboxBlobs];
      if (!isCurrentRequest()) return [];
      const names = finalData.map((blob: any) => getBlobName(blob));
      const ragEligibleNames = finalData.map(getModifiedBlobForRag).filter((blob: any) => isRagSourceEligible(blob, ownerAddress)).map((blob: any) => getBlobName(blob));
      if (!accessSnapshot.verified) {
        // A transient failure for one policy is not authoritative revocation
        // for every other blob. Persist the partial snapshot: resolved eligible
        // sources remain searchable, unresolved sources fail closed, and their
        // cached bytes are preserved for a later retry.
        await setShelbyBlobInventory(
          requestAuthority,
          names,
          ragEligibleNames,
          accessSnapshot.unresolvedNames,
          isCurrentRequest,
        );
        if (!isCurrentRequest()) return [];
        setBlobs(finalData);
        reconcileSelection(ragEligibleNames);
        toast({
          title: localize("Some files could not be verified", "Chưa xác minh được một số tệp"),
          description: localize(
            "Verified files remain searchable. Files with an unavailable access check are excluded until the next refresh.",
            "Các tệp đã xác minh vẫn có thể tra cứu. Tệp chưa kiểm tra được quyền sẽ tạm bị loại đến lần làm mới tiếp theo.",
          ),
        });
        return finalData;
      }
      await setShelbyBlobInventory(requestAuthority, names, ragEligibleNames, [], isCurrentRequest);
      if (!isCurrentRequest()) return [];
      setBlobs(finalData);
      reconcileSelection(ragEligibleNames);
      setLastSyncedAt(Date.now());
      return finalData;
    } catch (error) {
      if (!isCurrentRequest()) return [];
      const errorKind = classifyShelbyServiceError(error);
      const errorCopy = getShelbyRefreshErrorCopy(errorKind, currentLanguage());
      setLoadError(errorKind);
      console.warn("Unable to load blobs from Shelby", getShelbyErrorDiagnostic(error));
      if (!isSandboxMode) toast({
        title: errorCopy.title,
        description: errorCopy.description,
        variant: "destructive",
      });
      await invalidateShelbyBlobInventory(requestAuthority, isCurrentRequest);
      if (!isCurrentRequest()) return [];
      // Preserve the last-good visual and searchable snapshot. Inventory tools
      // still report it as stale, while document search remains scoped to the
      // last positively verified eligible names.
      setBlobs((previous) => previous.length ? previous : sandboxBlobs);
      return sandboxBlobs;
    } finally {
      if (isCurrentGeneration()) setLoading(false);
    }
  };

  const refreshBlobInventory: BlobInventoryRefreshCapability = async (detail, signal) => {
    signal?.throwIfAborted();
    const refreshOwner = currentOwnerRef.current;
    if (!refreshOwner || !account) return unavailableBlobInventoryRefresh("wallet_not_connected");
    const startedAt = Date.now();
    await fetchBlobs(signal);
    signal?.throwIfAborted();
    if (currentOwnerRef.current !== refreshOwner) return unavailableBlobInventoryRefresh("wallet_changed");
    const inventory = getShelbyBlobInventory();
    if (
      !inventory
      || inventory.owner.toLowerCase() !== createShelbyWorkspaceKey({ network, owner: refreshOwner })
      || inventory.verified !== true
      || inventory.fetchedAt < startedAt
    ) {
      return unavailableBlobInventoryRefresh("shelby_refresh_failed");
    }
    const count = inventory.names.length;
    return {
      status: "refreshed",
      count,
      ...(detail === "sample" ? { examples: inventory.names.slice(0, 3) } : {}),
      ...(detail === "all" ? {
        names: inventory.names.slice(0, 100),
        truncated: count > 100,
      } : {}),
      fetchedAt: inventory.fetchedAt,
      source: mockWorkspace ? "demo" : "shelby",
    };
  };

  const uploadFiles = async (files: File[], successTitle = localize("Upload complete", "Tải lên thành công!")) => {
    if (!account || files.length === 0) return;
    if (!mockWorkspace && (!capabilities.canWrite || capabilities.uploadProtocol !== "object-v2")) {
      const error = new ShelbyNetworkUnavailableError(network);
      toast({
        title: localize("Uploads are unavailable on this network", "Mạng này chưa hỗ trợ tải lên"),
        description: localize("Switch to ShelbyNet to continue.", "Hãy dùng ShelbyNet để tiếp tục."),
        variant: "destructive",
      });
      throw error;
    }
    if (uploadInFlightRef.current) {
      toast({
        title: localize("An upload is already running", "Một lượt tải lên đang chạy"),
        description: localize("Wait for it to finish before starting another upload.", "Hãy chờ lượt hiện tại hoàn tất trước khi chọn lượt mới."),
      });
      return;
    }
    uploadInFlightRef.current = true;
    const uploadController = new AbortController();
    uploadAbortRef.current = uploadController;
    const uploadOwner = account.address.toString();
    const normalizedUploadOwner = uploadOwner.toLowerCase();
    const uploadAuthority = createShelbyWorkspaceKey({ network, owner: normalizedUploadOwner });
    activeUploadAuthorityRef.current = uploadAuthority;
    const isCurrentUploadOwner = () => currentOwnerRef.current === normalizedUploadOwner
      && currentAuthorityRef.current === uploadAuthority
      && (mockWorkspace || walletNetworkReadyRef.current);
    const assertCurrentUpload = () => {
      uploadController.signal.throwIfAborted();
      if (isCurrentUploadOwner()) return;
      uploadController.abort(new DOMException(
        localize("The wallet or network changed; upload stopped.", "Ví hoặc mạng đã thay đổi; upload đã dừng."),
        "AbortError",
      ));
      uploadController.signal.throwIfAborted();
    };
    try {
      setUploading(true);
      const duplicateName = files.find((file, index) => files.findIndex((candidate) => candidate.name === file.name) !== index)?.name;
      if (duplicateName) throw new Error(localize(`Duplicate file name in this upload: ${duplicateName}`, `Tên tệp bị trùng trong lượt upload: ${duplicateName}`));
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

      // The explicit mock workspace has no real wallet signer or Shelby account.
      // Persist a session-only remote copy so the full backup/restore UX can be
      // tested without invoking the Clay WASM encoder against a fake account.
      if (mockWorkspace) {
        if (totalBytes > MAX_MOCK_UPLOAD_BYTES) throw new Error(localize("The demo can store up to 3 MB per browser session.", "Bản dùng thử chỉ lưu tối đa 3 MB trong phiên trình duyệt."));
        const ownerAddress = uploadOwner;
        const storageKey = `shelby-rag-explorer.mock-uploads:${ownerAddress.toLowerCase()}`;
        const previous = (() => {
          try {
            const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
            return Array.isArray(value) ? value : [];
          } catch {
            return [];
          }
        })();
        const next = [...previous];
        for (const file of files) {
          assertCurrentUpload();
          const parsedName = BlobNameSchema.safeParse(file.name);
          if (!parsedName.success) throw new Error(localize(`File name is not valid for Shelby: ${file.name}`, `Tên tệp không hợp lệ với Shelby: ${file.name}`));
          setUploadProgress({ phase: "uploading", fileName: file.name, completedBytes: 0, totalBytes });
          const isBinaryPack = file.name.toLowerCase().endsWith(".shelby-hot-rag.pack");
          const mockBlob = {
            owner: ownerAddress,
            blobId: `mock-upload-${Date.now()}-${file.name}`,
            blobNameSuffix: file.name,
            isMockUpload: true,
            mockContent: isBinaryPack ? undefined : await file.text(),
            mockBase64: isBinaryPack ? bytesToBase64(new Uint8Array(await file.arrayBuffer())) : undefined,
            creationMicros: Date.now() * 1_000,
            expirationMicros: Date.now() * 1_000 + YEAR_IN_MICROSECONDS,
            size: file.size,
            isWritten: true,
            isDeleted: false,
            accessPolicy: { type: "none", canAccess: true },
            metadata: { name: file.name, displayName: file.name, size: file.size, contentType: file.type || "application/octet-stream" },
          };
          const existingIndex = next.findIndex((item: any) => getBlobName(item) === file.name);
          if (existingIndex >= 0) next[existingIndex] = mockBlob;
          else next.push(mockBlob);
        }
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(next));
        } catch (storageError) {
          console.warn("sessionStorage quota reached for mock uploads; trimming older items.", storageError);
          try {
            sessionStorage.setItem(storageKey, JSON.stringify(next.slice(-10)));
          } catch {
            /* Keep in-memory if storage is fully exhausted */
          }
        }
        assertCurrentUpload();
        setUploadProgress({ phase: "done", completedBytes: totalBytes, totalBytes });
        toast({
          title: `${successTitle} ${localize("(Demo)", "(Bản dùng thử)")}`,
          description: localize(
            "Saved in this browser session; no transaction was sent to Shelby.",
            "Đã lưu trong phiên trình duyệt; chưa gửi giao dịch lên Shelby thật.",
          ),
        });
        await fetchBlobs();
        return;
      }

      const provider = await getErasureProvider();
      const expirationMicros = Date.now() * 1_000 + YEAR_IN_MICROSECONDS;
      type Commitments = Awaited<ReturnType<typeof generateCommitments>>;
      type PreparedFile = {
        blobName: string;
        file: File;
        commitments: Commitments;
        alreadyWritten: boolean;
        uid?: bigint;
        registrationHash?: string;
        expirationMicros?: number;
      };
      const prepared: PreparedFile[] = [];
      const blobsToRegister: Array<{ blobName: any; blobSize: number; blobMerkleRoot: string; numChunksets: number }> = [];
      const existingJournal = loadUploadJournal(network, uploadOwner);
      let recoveryWarningShown = false;
      const warnRecoveryUnavailable = () => {
        if (recoveryWarningShown) return;
        recoveryWarningShown = true;
        toast({
          title: localize("Upload recovery is unavailable", "Không thể lưu trạng thái khôi phục"),
          description: localize(
            "Keep this tab open until the upload finishes. Shelby operations can continue, but this browser cannot save resume progress.",
            "Hãy giữ tab này mở đến khi tải xong. Thao tác Shelby vẫn tiếp tục, nhưng trình duyệt không thể lưu tiến độ để tiếp tục sau khi gián đoạn.",
          ),
        });
      };
      const persistUploadRecovery = (record: UploadJournalRecord) => {
        if (!upsertUploadJournal(record)) warnRecoveryUnavailable();
      };
      const clearUploadRecovery = (blobName: string) => {
        if (!removeUploadJournal(network, uploadOwner, blobName)) warnRecoveryUnavailable();
      };

      for (const file of files) {
        assertCurrentUpload();
        const parsedName = BlobNameSchema.safeParse(file.name);
        if (!parsedName.success) throw new Error(localize(`File name is not valid for Shelby: ${file.name}`, `Tên tệp không hợp lệ với Shelby: ${file.name}`));
        const blobName = parsedName.data;
        setUploadProgress({ phase: "commitments", fileName: blobName, completedBytes: 0, totalBytes });
        const commitments = await generateCommitments(provider, file.stream());
        assertCurrentUpload();
        const existing = await runtime.blobClient.getFullObjectMetadata({ account: uploadOwner, name: blobName });
        assertCurrentUpload();
        const merkleRoot = commitments.blob_merkle_root.replace(/^0x/, "").toLowerCase();
        if (existing) {
          if (existing.isDeleted === true) throw new Error(localize(
            `Blob “${blobName}” was deleted on Shelby and cannot be overwritten. Save it under a new name.`,
            `Blob “${blobName}” đã bị xoá trên Shelby và không thể ghi đè. Hãy lưu bản mới với tên khác.`,
          ));
          if (Number(existing.expirationMicros ?? 0) > 0 && Number(existing.expirationMicros) <= Date.now() * 1_000) {
            throw new Error(localize(
              `Blob “${blobName}” has expired on Shelby. Save it under a new name.`,
              `Blob “${blobName}” đã hết hạn trên Shelby. Hãy lưu bản mới với tên khác.`,
            ));
          }
          const sameContent = existing.size === file.size && bytesToHex(existing.blobMerkleRoot) === merkleRoot;
          if (!sameContent) throw new Error(localize(
            `Blob “${blobName}” already exists with different content. Rename the file.`,
            `Blob “${blobName}” đã tồn tại nhưng nội dung khác. Hãy đổi tên tệp.`,
          ));
          if (existing.isWritten) clearUploadRecovery(blobName);
          if (!existing.isWritten && existing.uid === undefined) throw new Error(localize(
            `Shelby returned an incomplete registration for “${blobName}” without its UID.`,
            `Shelby trả về đăng ký chưa hoàn tất cho “${blobName}” nhưng thiếu UID.`,
          ));
          prepared.push({
            blobName,
            file,
            commitments,
            alreadyWritten: existing.isWritten,
            uid: existing.uid,
            expirationMicros: Number(existing.expirationMicros) || expirationMicros,
          });
          continue;
        }

        const journalForName = existingJournal.find((item) => item.blobName === blobName);
        const resumable = findMatchingUploadJournal({ network, owner: uploadOwner, blobName, size: file.size, merkleRoot });
        if (journalForName && !resumable) throw new Error(localize(
          `Select the original bytes for “${blobName}” to resume, or rename this different file.`,
          `Hãy chọn lại đúng dữ liệu gốc của “${blobName}” để tiếp tục, hoặc đổi tên tệp khác nội dung này.`,
        ));
        if (resumable) {
          prepared.push({
            blobName,
            file,
            commitments,
            alreadyWritten: false,
            uid: BigInt(resumable.uid),
            registrationHash: resumable.registrationHash,
            expirationMicros: resumable.expirationMicros,
          });
        } else {
          blobsToRegister.push({ blobName, blobSize: file.size, blobMerkleRoot: commitments.blob_merkle_root, numChunksets: commitments.chunkset_commitments.length });
          prepared.push({ blobName, file, commitments, alreadyWritten: false });
        }
      }

      if (blobsToRegister.length > 0) {
        assertCurrentUpload();
        setUploadProgress({ phase: "registering", completedBytes: 0, totalBytes });
        let locationHint = runtime.blobClient.defaultOptions.locationHint;
        if (!locationHint && !runtime.blobClient.defaultOptions.selectedLocation) {
          const locations = await runtime.client.metadata.getLocationNames();
          assertCurrentUpload();
          locationHint = locations[0];
        }
        if (!locationHint && !runtime.blobClient.defaultOptions.selectedLocation) throw new Error(localize(
          "Shelby did not return an active storage location for this network.",
          "Shelby chưa trả về vùng lưu trữ đang hoạt động cho mạng này.",
        ));
        const payload = ShelbyBlobClient.createBatchRegisterBlobsPayload({
          deployer: runtime.blobClient.deployer,
          account: AccountAddress.fromString(uploadOwner),
          selectedLocation: runtime.blobClient.defaultOptions.selectedLocation,
          locationHint,
          expirationMicros,
          blobs: blobsToRegister,
          encoding: provider.config.enumIndex,
          encryption: "Unencrypted",
        });
        toast({
          title: localize("Signature 1: register the files", "Chữ ký 1: đăng ký các tệp"),
          description: localize(`After this, the wallet will request ${blobsToRegister.length} more signature(s) to finalize each new blob.`, `Sau đó ví sẽ yêu cầu thêm ${blobsToRegister.length} chữ ký để hoàn tất từng blob mới.`),
        });
        const response = await signAndSubmitTransaction({ data: payload as any });
        assertCurrentUpload();
        setUploadProgress({ phase: "confirming", completedBytes: 0, totalBytes });
        const receipt = await runtime.aptos.waitForTransaction({ transactionHash: response.hash, options: { checkSuccess: true, waitForIndexer: true } });
        assertCurrentUpload();
        const registered = ShelbyBlobClient.registeredBlobUids((receipt as any).events ?? [], runtime.blobClient.deployer);
        const newlyRegistered = prepared.filter((entry) => !entry.alreadyWritten && entry.uid === undefined);
        const uidResolution = resolveRegisteredBlobUids(uploadOwner, newlyRegistered.map((item) => item.blobName), registered);
        for (const item of newlyRegistered) {
          const uid = uidResolution.resolved.get(item.blobName);
          if (uid === undefined) continue;
          item.uid = uid;
          item.registrationHash = response.hash;
          item.expirationMicros = expirationMicros;
          persistUploadRecovery({
            version: 1, network, owner: uploadOwner, blobName: item.blobName, size: item.file.size,
            merkleRoot: item.commitments.blob_merkle_root.replace(/^0x/, "").toLowerCase(), uid: uid.toString(),
            registrationHash: response.hash, expirationMicros, stage: "registered", updatedAt: Date.now(),
          });
        }
        if (uidResolution.missing.length) throw new Error(localize(
          `The registration receipt did not contain UID(s) for: ${uidResolution.missing.join(", ")}.`,
          `Biên nhận đăng ký thiếu UID cho: ${uidResolution.missing.join(", ")}.`,
        ));
      }

      const failures: Array<{ blobName: string; error: unknown }> = [];
      let completedBeforeFile = prepared.filter((item) => item.alreadyWritten).reduce((sum, item) => sum + item.file.size, 0);
      let completedFiles = prepared.filter((item) => item.alreadyWritten).length;
      for (const item of prepared.filter((entry) => !entry.alreadyWritten)) {
        const uid = item.uid;
        if (uid === undefined) {
          failures.push({ blobName: item.blobName, error: new Error("missing_uid") });
          continue;
        }
        const journalBase: UploadJournalRecord = {
          version: 1, network, owner: uploadOwner, blobName: item.blobName, size: item.file.size,
          merkleRoot: item.commitments.blob_merkle_root.replace(/^0x/, "").toLowerCase(), uid: uid.toString(),
          registrationHash: item.registrationHash ?? "recovered",
          expirationMicros: item.expirationMicros ?? expirationMicros,
          stage: "registered",
          updatedAt: Date.now(),
        };
        let journalState = journalBase;
        try {
          assertCurrentUpload();
          const uploadResult = await runtime.rpcClient.putBlobChunksets({
            accountAddress: uploadOwner,
            uid,
            blobData: item.file.stream(),
            commitments: item.commitments,
            totalBytes: item.file.size,
            signal: uploadController.signal,
            onProgress: (progress) => {
              if (isCurrentUploadOwner()) setUploadProgress({ phase: "uploading", fileName: item.blobName, completedBytes: completedBeforeFile + progress.uploadedBytes, totalBytes });
            },
          });
          assertCurrentUpload();
          const acknowledgementsNeeded = requiredAckCount(provider.config.erasure_n);
          const acknowledgementCount = uniqueStorageProviderAckCount(uploadResult.spAcks);
          if (acknowledgementCount < acknowledgementsNeeded) throw new Error(localize(
            `Only ${acknowledgementCount}/${acknowledgementsNeeded} storage providers acknowledged “${item.blobName}”.`,
            `Chỉ ${acknowledgementCount}/${acknowledgementsNeeded} nhà lưu trữ xác nhận “${item.blobName}”.`,
          ));
          journalState = { ...journalState, stage: "uploaded", updatedAt: Date.now() };
          persistUploadRecovery(journalState);

          setUploadProgress({ phase: "committing", fileName: item.blobName, completedBytes: completedBeforeFile + item.file.size, totalBytes });
          toast({ title: localize(`Finalize ${item.blobName}`, `Hoàn tất ${item.blobName}`), description: localize("Sign once to make this blob durable and visible.", "Ký một lần để blob này được ghi nhận hoàn tất và hiển thị.") });
          const commitPayload = ShelbyBlobClient.createCommitObjectPayload({
            deployer: runtime.blobClient.deployer,
            uid,
            blobName: item.blobName,
            overwrite: false,
            storageProviderAcks: uploadResult.spAcks,
          });
          journalState = { ...journalState, stage: "committing", updatedAt: Date.now() };
          persistUploadRecovery(journalState);
          const commitResponse = await signAndSubmitTransaction({ data: commitPayload as any });
          journalState = { ...journalState, stage: "committing", commitHash: commitResponse.hash, updatedAt: Date.now() };
          persistUploadRecovery(journalState);
          assertCurrentUpload();
          const commitReceipt = await runtime.aptos.waitForTransaction({ transactionHash: commitResponse.hash, options: { checkSuccess: true, waitForIndexer: true } });
          assertCurrentUpload();
          const rejection = ShelbyBlobClient.findObjectCommitRejection((commitReceipt as any).events ?? [], runtime.blobClient.deployer, uid);
          const rejectionFailure = objectCommitFailure(rejection, true);
          if (rejectionFailure === "commit_rejected") throw new Error(localize(
            `Shelby rejected the final commit for “${item.blobName}”: ${rejection}.`,
            `Shelby từ chối commit cuối cho “${item.blobName}”: ${rejection}.`,
          ));
          const committed = await runtime.blobClient.getFullObjectMetadata({ account: uploadOwner, name: item.blobName });
          assertCurrentUpload();
          if (objectCommitFailure(null, committed?.isWritten) === "not_written") throw new Error(localize(
            `“${item.blobName}” was not confirmed as committed after the final transaction.`,
            `“${item.blobName}” chưa được xác nhận committed sau giao dịch cuối.`,
          ));
          clearUploadRecovery(item.blobName);
          completedBeforeFile += item.file.size;
          completedFiles += 1;
        } catch (error) {
          journalState = {
            ...journalState,
            stage: "failed",
            updatedAt: Date.now(),
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          };
          persistUploadRecovery(journalState);
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          failures.push({ blobName: item.blobName, error });
        }
      }

      if (isCurrentUploadOwner()) {
        await queryClient.invalidateQueries({ queryKey: getUseAccountBlobsQueryKey({ network: toAptosNetwork(network), account: uploadOwner }) });
        await fetchBlobs();
        if (!failures.length) {
          setUploadProgress({ phase: "done", completedBytes: totalBytes, totalBytes });
          toast({ title: successTitle, description: localize(`${completedFiles} blob(s) are committed on ${network === "shelbynet" ? "ShelbyNet" : "Shelby Testnet"}.`, `${completedFiles} blob đã committed trên ${network === "shelbynet" ? "ShelbyNet" : "Shelby Testnet"}.`) });
        }
      }
      if (failures.length) {
        throw new Error(localize(
          `${completedFiles}/${prepared.length} blobs completed. Re-select the same failed files to resume.`,
          `${completedFiles}/${prepared.length} blob hoàn tất. Chọn lại đúng các tệp lỗi để tiếp tục.`,
        ));
      }
    } catch (error: any) {
      console.error(error);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const friendlyMessage = /WebAssembly|magic word/i.test(rawMessage)
        ? localize(
          "The Shelby data processor did not load. Refresh the page and try again. If the issue persists, verify that the server returns clay.wasm with the correct format.",
          "Bộ xử lý dữ liệu Shelby chưa tải được. Hãy tải lại trang rồi thử lại; nếu vẫn lỗi, kiểm tra file clay.wasm có được máy chủ trả đúng định dạng hay không.",
        )
        : rawMessage;
      if (isCurrentUploadOwner()) toast({ title: localize("Could not save to Shelby", "Không thể lưu lên Shelby"), description: friendlyMessage, variant: "destructive" });
      throw error;
    } finally {
      uploadInFlightRef.current = false;
      activeUploadAuthorityRef.current = "";
      if (uploadAbortRef.current === uploadController) uploadAbortRef.current = null;
      setUploading(false);
      window.setTimeout(() => setUploadProgress(null), 800);
    }
  };

  useEffect(() => {
    fetchGenerationRef.current += 1;
    setBlobs([]);
    setSelectedBlobNames([]);
    setLastSyncedAt(null);
    setLoadError(null);
    setLoading(Boolean(ownerKey && walletNetworkReady));
    setUploading(false);
    setUploadProgress(null);
    if (ownerKey && walletNetworkReady) void fetchBlobs();
    return () => { fetchGenerationRef.current += 1; };
  }, [ownerKey, authorityKey, network, walletNetworkReady]);

  return {
    account,
    signMessage,
    blobs,
    loading,
    uploading,
    uploadProgress,
    isSandboxMode,
    selectedBlobNames,
    setSelectedBlobNames,
    lastSyncedAt,
    loadError,
    mockBalance,
    mockPurchasedBlobNames,
    adjustMockBalance,
    getBlobName,
    getModifiedBlobForRag,
    isPurchasableAndLocked,
    handlePurchaseAccess,
    fetchBlobs,
    refreshBlobInventory,
    uploadFiles,
  };
}
