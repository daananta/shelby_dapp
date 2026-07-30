import { useState, useEffect, useRef } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { AccountAddress } from "@aptos-labs/ts-sdk";
import { BlobNameSchema, ShelbyBlobClient, generateCommitments } from "@shelby-protocol/sdk/browser";
import { blobClient, rpcClient } from "@/utils/shelbyConfig";
import { aptosClient } from "@/utils/aptosClient";
import { useToast } from "@/components/ui/use-toast";
import { queryAccessPolicies } from "@/utils/accessControl";
import { isRagSourceEligible } from "@/utils/blobAccess";
import { getShelbyBlobInventory, invalidateShelbyBlobInventory, setShelbyBlobInventory, setActiveRagOwner } from "@/utils/ragOrama";
import { isMockWorkspace } from "@/utils/devMode";
import { bytesToHex } from "@/utils/contentIntegrity";
import { getErasureProvider } from "@/utils/shelbyErasure";
import { localize } from "@/i18n";
import { unavailableBlobInventoryRefresh, type BlobInventoryRefreshCapability } from "@/utils/agentCapabilities";

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
  phase: "commitments" | "registering" | "confirming" | "uploading" | "done";
  fileName?: string;
  completedBytes: number;
  totalBytes: number;
}

export function useShelby() {
  const { account: realAccount, signAndSubmitTransaction, signMessage } = useWallet();
  const mockWorkspace = isMockWorkspace();
  const account = mockWorkspace
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
  const fetchGenerationRef = useRef(0);
  const uploadInFlightRef = useRef(false);
  const knownEligibleNamesRef = useRef<{ owner: string; names: Set<string> }>({ owner: "", names: new Set() });
  const ownerKey = account?.address?.toString().toLowerCase() ?? "";
  const currentOwnerRef = useRef(ownerKey);
  currentOwnerRef.current = ownerKey;

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
    if (!account) return [];
    const requestGeneration = ++fetchGenerationRef.current;
    const ownerAddress = account.address.toString();
    const normalizedOwner = ownerAddress.toLowerCase();
    const isCurrentGeneration = () => requestGeneration === fetchGenerationRef.current && currentOwnerRef.current === normalizedOwner;
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
      const firstInventoryForOwner = previousInventory.owner !== normalizedOwner;
      const eligible = new Set(eligibleNames);
      const newlyDiscovered = firstInventoryForOwner ? eligibleNames : eligibleNames.filter((name) => !previousInventory.names.has(name));
      knownEligibleNamesRef.current = { owner: normalizedOwner, names: eligible };
      setSelectedBlobNames((previous) => firstInventoryForOwner
        ? eligibleNames
        : [...new Set([...previous.filter((name) => eligible.has(name)), ...newlyDiscovered])]);
    };

    if (mockWorkspace) {
      await setActiveRagOwner(ownerAddress);
      if (!isCurrentRequest()) return [];
      const names = sandboxBlobs.map((blob: any) => getBlobName(blob));
      const ragEligibleNames = sandboxBlobs.map(getModifiedBlobForRag).filter((blob: any) => isRagSourceEligible(blob, ownerAddress)).map((blob: any) => getBlobName(blob));
      await setShelbyBlobInventory(ownerAddress, names, ragEligibleNames);
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
      await setActiveRagOwner(ownerAddress);
      if (!isCurrentRequest()) return [];
      data = await blobClient.getAccountBlobs({ account: account.address });
      if (!isCurrentRequest()) return [];
      const accessSnapshot = await queryAccessPolicies(ownerAddress, data.map((blob: any) => getBlobName(blob)), signal);
      enrichedData = data.map((blob: any) => ({ ...blob, accessPolicy: accessSnapshot.policies.get(getBlobName(blob)) ?? { type: "unknown", canAccess: null } }));
      const finalData = [...enrichedData, ...sandboxBlobs];
      if (!isCurrentRequest()) return [];
      const names = finalData.map((blob: any) => getBlobName(blob));
      const ragEligibleNames = finalData.map(getModifiedBlobForRag).filter((blob: any) => isRagSourceEligible(blob, ownerAddress)).map((blob: any) => getBlobName(blob));
      if (!accessSnapshot.verified) {
        // A transient policy RPC/BCS failure is not authoritative revocation.
        // Disable search, but preserve already indexed bytes until a fully
        // verified policy snapshot can reconcile them.
        await invalidateShelbyBlobInventory(ownerAddress);
        if (!isCurrentRequest()) return [];
        setBlobs(finalData);
        toast({
          title: localize("Shelby loaded; access check is unavailable", "Đã tải Shelby; chưa kiểm tra được quyền truy cập"),
          description: localize(
            "Your local RAG was preserved, but document search is paused until access policies can be verified.",
            "RAG trên máy vẫn được giữ, nhưng tra cứu tài liệu tạm dừng đến khi xác minh lại được quyền truy cập.",
          ),
        });
        return finalData;
      }
      await setShelbyBlobInventory(ownerAddress, names, ragEligibleNames);
      if (!isCurrentRequest()) return [];
      setBlobs(finalData);
      reconcileSelection(ragEligibleNames);
      setLastSyncedAt(Date.now());
      return finalData;
    } catch (error) {
      if (!isCurrentRequest()) return [];
      console.warn("Unable to load blobs from Shelby:", error);
      if (!isSandboxMode) toast({
        title: localize("Could not refresh Shelby data", "Không thể đồng bộ Shelby"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
      await invalidateShelbyBlobInventory(ownerAddress);
      if (!isCurrentRequest()) return [];
      setBlobs(sandboxBlobs);
      const ragEligibleNames = sandboxBlobs.map(getModifiedBlobForRag).filter((blob: any) => isRagSourceEligible(blob, ownerAddress)).map((blob: any) => getBlobName(blob));
      reconcileSelection(ragEligibleNames);
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
      || inventory.owner.toLowerCase() !== refreshOwner
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
    if (uploadInFlightRef.current) {
      toast({
        title: localize("An upload is already running", "Một lượt tải lên đang chạy"),
        description: localize("Wait for it to finish before starting another upload.", "Hãy chờ lượt hiện tại hoàn tất trước khi chọn lượt mới."),
      });
      return;
    }
    uploadInFlightRef.current = true;
    const uploadOwner = account.address.toString();
    const normalizedUploadOwner = uploadOwner.toLowerCase();
    const isCurrentUploadOwner = () => currentOwnerRef.current === normalizedUploadOwner;
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
          if (!isCurrentUploadOwner()) throw new DOMException(localize("The wallet changed; upload stopped.", "Ví đã thay đổi; đã dừng tải lên."), "AbortError");
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
        sessionStorage.setItem(storageKey, JSON.stringify(next));
        if (!isCurrentUploadOwner()) return;
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

      const blobsToRegister = [];
      const filesData: Array<{ blobName: string; file: File; alreadyWritten: boolean }> = [];

      for (const file of files) {
        if (!isCurrentUploadOwner()) throw new DOMException(localize("The wallet changed; upload preparation stopped.", "Ví đã thay đổi; đã dừng chuẩn bị upload."), "AbortError");
        const parsedName = BlobNameSchema.safeParse(file.name);
        if (!parsedName.success) throw new Error(localize(`File name is not valid for Shelby: ${file.name}`, `Tên tệp không hợp lệ với Shelby: ${file.name}`));
        const blobName = parsedName.data;
        setUploadProgress({ phase: "commitments", fileName: blobName, completedBytes: 0, totalBytes });
        const commitments = await generateCommitments(provider, file.stream());
        if (!isCurrentUploadOwner()) throw new DOMException(localize("The wallet changed; upload preparation stopped.", "Ví đã thay đổi; đã dừng chuẩn bị upload."), "AbortError");
        const existing = await blobClient.getBlobMetadata({ account: uploadOwner, name: blobName });
        if (!isCurrentUploadOwner()) throw new DOMException(localize("The wallet changed; upload preparation stopped.", "Ví đã thay đổi; đã dừng chuẩn bị upload."), "AbortError");
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
          const sameContent = existing.size === file.size && bytesToHex(existing.blobMerkleRoot) === commitments.blob_merkle_root.replace(/^0x/, "").toLowerCase();
          if (!sameContent) throw new Error(localize(
            `Blob “${blobName}” already exists with different content. Rename the file.`,
            `Blob “${blobName}” đã tồn tại nhưng nội dung khác. Hãy đổi tên tệp.`,
          ));
        } else {
          blobsToRegister.push({
            blobName,
            blobSize: file.size,
            blobMerkleRoot: commitments.blob_merkle_root,
            numChunksets: commitments.chunkset_commitments.length,
          });
        }
        filesData.push({ blobName, file, alreadyWritten: existing?.isWritten === true });
      }

      if (blobsToRegister.length > 0) {
        if (!isCurrentUploadOwner()) throw new DOMException(localize("The wallet changed; blob registration stopped.", "Ví đã thay đổi; đã dừng đăng ký blob."), "AbortError");
        setUploadProgress({ phase: "registering", completedBytes: 0, totalBytes });
        const payload = ShelbyBlobClient.createBatchRegisterBlobsPayload({
          account: AccountAddress.fromString(uploadOwner),
          expirationMicros,
          blobs: blobsToRegister,
          encoding: provider.config.enumIndex
        });
        const aptos = aptosClient();
        if (!isCurrentUploadOwner()) throw new DOMException(localize("The wallet changed; blob registration stopped.", "Ví đã thay đổi; đã dừng đăng ký blob."), "AbortError");
        toast({ title: localize("Waiting for your wallet signature…", "Đang yêu cầu chữ ký ví…") });
        const response = await signAndSubmitTransaction({ data: payload as any });
        if (isCurrentUploadOwner()) {
          setUploadProgress({ phase: "confirming", completedBytes: 0, totalBytes });
          toast({ title: localize("Waiting for blockchain confirmation…", "Đang chờ blockchain xác nhận…") });
        }
        await aptos.waitForTransaction({ transactionHash: response.hash, options: { checkSuccess: true, waitForIndexer: true } });
      }

      if (isCurrentUploadOwner()) toast({ title: localize("Registration confirmed. Uploading data…", "Đăng ký xong. Bắt đầu tải lên dữ liệu…") });

      let completedBeforeFile = filesData.filter((item) => item.alreadyWritten).reduce((sum, item) => sum + item.file.size, 0);
      for (const fd of filesData.filter((item) => !item.alreadyWritten)) {
        await rpcClient.putBlob({
          account: uploadOwner,
          blobName: fd.blobName,
          blobData: fd.file.stream(),
          totalBytes: fd.file.size,
          onProgress: (progress) => {
            if (isCurrentUploadOwner()) setUploadProgress({ phase: "uploading", fileName: fd.blobName, completedBytes: completedBeforeFile + progress.uploadedBytes, totalBytes });
          },
        });
        completedBeforeFile += fd.file.size;
      }

      if (isCurrentUploadOwner()) {
        setUploadProgress({ phase: "done", completedBytes: totalBytes, totalBytes });
        toast({ title: successTitle });
        await fetchBlobs();
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
      if (isCurrentUploadOwner()) {
        setUploading(false);
        window.setTimeout(() => {
          if (isCurrentUploadOwner()) setUploadProgress(null);
        }, 800);
      }
    }
  };

  useEffect(() => {
    fetchGenerationRef.current += 1;
    setBlobs([]);
    setSelectedBlobNames([]);
    setLastSyncedAt(null);
    setLoading(Boolean(ownerKey));
    setUploading(false);
    setUploadProgress(null);
    if (ownerKey) void fetchBlobs();
    return () => { fetchGenerationRef.current += 1; };
  }, [ownerKey]);

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
