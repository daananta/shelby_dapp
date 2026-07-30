import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { BookOpen, MessageSquare, Play } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/Header";
import { WalletSelector } from "@/components/WalletSelector";
import { isE2EWalletConnected, isMockWorkspace } from "@/utils/devMode";
import { JudgeMode, type JudgeModeReadiness } from "@/components/JudgeMode";
import { Button } from "@/components/ui/button";
import type { JudgeModeTarget } from "@/utils/judgeMode";
import { useLanguage } from "@/i18n";
import {
  unavailableBlobInventoryRefresh,
  type BlobInventoryRefreshCapability,
  type RegisterBlobInventoryRefresh,
} from "@/utils/agentCapabilities";

// Lazy-loaded heavy components
const ShelbyExplorer = lazy(() => import("@/components/ShelbyExplorer").then((module) => ({ default: module.ShelbyExplorer })));
const UnifiedChat = lazy(() => import("@/components/UnifiedChat").then((module) => ({ default: module.UnifiedChat })));

interface AppProps {
  onOpenDemo?: () => void;
}

function App({ onOpenDemo }: AppProps) {
  const { t } = useLanguage();
  const { connected: realConnected, account } = useWallet();
  const isTestMode = isE2EWalletConnected();
  const connected = isTestMode ? true : realConnected;
  const readinessOwner = isMockWorkspace() ? "mock-workspace" : isTestMode ? "e2e-remote-error" : account?.address.toString().toLowerCase() ?? "";
  const [mobileView, setMobileView] = useState<"library" | "chat">("library");
  const [judgeModeOpen, setJudgeModeOpen] = useState(false);
  const [judgeReadiness, setJudgeReadiness] = useState<JudgeModeReadiness>({ walletConnected: connected });
  const blobInventoryRefreshRef = useRef<{
    token: symbol;
    capability: BlobInventoryRefreshCapability;
  } | null>(null);
  const registerBlobInventoryRefresh = useCallback<RegisterBlobInventoryRefresh>((capability) => {
    const token = Symbol("blob-inventory-refresh");
    blobInventoryRefreshRef.current = { token, capability };
    return () => {
      if (blobInventoryRefreshRef.current?.token === token) {
        blobInventoryRefreshRef.current = null;
      }
    };
  }, []);
  const refreshBlobInventory = useCallback<BlobInventoryRefreshCapability>((detail, signal) => {
    signal?.throwIfAborted();
    const registered = blobInventoryRefreshRef.current;
    return registered
      ? registered.capability(detail, signal)
      : Promise.resolve(unavailableBlobInventoryRefresh());
  }, []);

  useEffect(() => {
    const openAiSettings = () => setMobileView("chat");
    const openRagConfig = () => setMobileView("library");
    window.addEventListener("shelby:open-ai-settings", openAiSettings);
    window.addEventListener("shelby:open-rag-config", openRagConfig);
    return () => {
      window.removeEventListener("shelby:open-ai-settings", openAiSettings);
      window.removeEventListener("shelby:open-rag-config", openRagConfig);
    };
  }, []);

  useEffect(() => setJudgeReadiness({ walletConnected: connected }), [connected, readinessOwner]);

  useEffect(() => {
    const updateReadiness = (event: Event) => {
      const detail = (event as CustomEvent<JudgeModeReadiness>).detail;
      if (detail) setJudgeReadiness((current) => ({ ...current, ...detail }));
    };
    window.addEventListener("shelby:judge-readiness", updateReadiness);
    return () => window.removeEventListener("shelby:judge-readiness", updateReadiness);
  }, []);

  const navigateJudgeMode = (target: JudgeModeTarget) => {
    if (target === "library" || target === "backup") {
      setMobileView("library");
      window.dispatchEvent(new CustomEvent("shelby:judge-navigate", { detail: target }));
      return;
    }
    setMobileView("chat");
    window.dispatchEvent(new CustomEvent("shelby:judge-navigate", { detail: target }));
  };

  const openJudgeMode = () => {
    setJudgeModeOpen(true);
    window.dispatchEvent(new Event("shelby:judge-readiness-request"));
  };

  return (
    <main className="app-canvas relative flex min-h-dvh flex-col overflow-x-hidden text-slate-900 dark:text-slate-200 xl:h-dvh xl:min-h-[680px] xl:overflow-hidden">
      <Header onOpenJudgeMode={connected ? openJudgeMode : onOpenDemo} />

      <div className="relative z-10 mx-auto flex min-h-[calc(100dvh-4.5rem)] w-full max-w-[1580px] flex-1 flex-col px-2 pb-3 pt-2.5 sm:px-4 sm:pb-4 xl:min-h-0">
        {connected ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Mobile nav */}
            <nav className="grid grid-cols-2 rounded-xl border border-slate-200/60 bg-white/70 p-1 backdrop-blur-md dark:border-white/[0.08] dark:bg-slate-950/40 xl:hidden" aria-label={t("Workspace navigation", "Điều hướng khu làm việc")} role="tablist">
              <button role="tab" aria-selected={mobileView === "library"} onClick={() => setMobileView("library")} className={`flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-all ${mobileView === "library" ? "bg-[#172019] text-[#c5fb7e] shadow-sm dark:bg-lime-300 dark:text-slate-950" : "text-slate-500 dark:text-slate-400 hover:bg-black/[0.035] dark:hover:bg-white/[0.04]"}`}>
                <BookOpen className="h-3.5 w-3.5" />{t("Library", "Thư viện")}
              </button>
              <button role="tab" aria-selected={mobileView === "chat"} onClick={() => setMobileView("chat")} className={`flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-all ${mobileView === "chat" ? "bg-[#172019] text-[#c5fb7e] shadow-sm dark:bg-lime-300 dark:text-slate-950" : "text-slate-500 dark:text-slate-400 hover:bg-black/[0.035] dark:hover:bg-white/[0.04]"}`}>
                <MessageSquare className="h-3.5 w-3.5" />{t("Chat", "Chat")}
              </button>
            </nav>

            {/* Two-column workspace (Sidebar + Main View) */}
            <div className="grid min-h-0 flex-1 gap-3.5 xl:h-full xl:grid-cols-[minmax(460px,0.92fr)_minmax(620px,1.08fr)] 2xl:grid-cols-[minmax(500px,0.95fr)_minmax(680px,1.05fr)]">
              {/* Sidebar (Explorer / List) */}
              <aside data-testid="knowledge-panel" role="tabpanel" className={`${mobileView === "library" ? "flex" : "hidden"} h-[760px] min-h-0 flex-col overflow-hidden xl:h-full xl:flex`}>
                <Suspense fallback={<div className="section-surface p-6 text-center text-xs text-slate-400"><BookOpen className="mx-auto mb-1.5 h-4 w-4 text-emerald-600" />{t("Loading…", "Đang tải…")}</div>}>
                  <ShelbyExplorer registerBlobInventoryRefresh={registerBlobInventoryRefresh} />
                </Suspense>
              </aside>
              {/* Main Workspace (Chat) */}
              <section data-testid="chat-panel" role="tabpanel" className={`${mobileView === "chat" ? "block" : "hidden"} h-[max(620px,calc(100dvh-8.5rem))] min-h-0 min-w-0 overflow-hidden xl:h-full xl:block`}>
                <Suspense fallback={<div className="section-surface p-6 text-center text-xs text-slate-400"><MessageSquare className="mx-auto mb-1.5 h-4 w-4 text-emerald-600" />{t("Loading…", "Đang tải…")}</div>}>
                  <UnifiedChat refreshBlobInventory={refreshBlobInventory} />
                </Suspense>
              </section>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-3 py-10">
            <section className="section-surface w-full max-w-lg rounded-[24px] p-7 text-center sm:p-9" aria-labelledby="connect-workspace-title">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-lime-300 dark:bg-lime-300 dark:text-slate-950"><BookOpen className="h-5 w-5" /></div>
              <h2 id="connect-workspace-title" className="mt-5 text-xl font-extrabold text-slate-950 dark:text-white">{t("Connect a wallet to open your library", "Kết nối ví để mở kho của bạn")}</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">{t("Documents, chat history, and access rights stay isolated for each wallet address.", "Tài liệu, lịch sử trò chuyện và quyền truy cập được tách riêng theo từng địa chỉ ví.")}</p>
              <div className="mt-6 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
                <WalletSelector />
                {onOpenDemo && (
                  <Button type="button" variant="outline" className="rounded-xl" onClick={onOpenDemo}>
                    <Play className="mr-2 h-4 w-4" />{t("Try the wallet-free demo", "Xem mô phỏng không cần ví")}
                  </Button>
                )}
              </div>
              {onOpenDemo && <p className="mt-3 text-xs text-slate-400">{t("The simulation uses sample data; the 90-second workspace demo uses real Shelby data.", "Mô phỏng dùng dữ liệu minh hoạ; demo 90 giây trong kho sẽ dùng dữ liệu Shelby thật.")}</p>}
            </section>
          </div>
        )}
      </div>
      <JudgeMode
        open={judgeModeOpen}
        onClose={() => setJudgeModeOpen(false)}
        readiness={judgeReadiness}
        onNavigate={navigateJudgeMode}
        onSelectQuestion={(question) => window.dispatchEvent(new CustomEvent("shelby:judge-question", { detail: question }))}
      />
    </main>
  );
}

export default App;
