import "../vite.polyfills";
import "./index.css";

import React, { Suspense, lazy, useState } from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "@/components/ui/toaster.tsx";
import { Landing } from "@/components/Landing";
import { LanguageProvider, useLanguage } from "@/i18n";
import { ShelbyNetworkProvider } from "@/network/ShelbyNetworkProvider";

const WalletWorkspace = lazy(() => import("@/WalletWorkspace"));
const DemoWorkspace = lazy(() => import("@/DemoWorkspace"));

class WalletRuntimeBoundary extends React.Component<{
  children: React.ReactNode;
  onExit: () => void;
  title: string;
  description: string;
  action: string;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-canvas flex min-h-screen items-center justify-center px-4">
        <section className="section-surface max-w-md rounded-3xl p-8 text-center">
          <h1 className="text-xl font-extrabold text-slate-950 dark:text-white">{this.props.title}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{this.props.description}</p>
          <button type="button" className="mt-5 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white dark:bg-lime-300 dark:text-slate-950" onClick={this.props.onExit}>{this.props.action}</button>
        </section>
      </main>
    );
  }
}

function Bootstrap() {
  const [view, setView] = useState<"landing" | "wallet" | "demo">("landing");
  const { t } = useLanguage();
  if (view === "wallet") return (
    <WalletRuntimeBoundary
      onExit={() => setView("landing")}
      title={t("The workspace could not open", "Không thể mở workspace")}
      description={t("Return home, confirm the selected network, and try again.", "Hãy quay lại, kiểm tra mạng đã chọn rồi thử lại.")}
      action={t("Back to home", "Về trang chủ")}
    >
      <Suspense fallback={<main className="app-canvas flex min-h-screen items-center justify-center text-sm text-slate-500">{t("Opening Shelby workspace…", "Đang mở kết nối Shelby…")}</main>}>
        <WalletWorkspace onOpenDemo={() => setView("demo")} />
      </Suspense>
    </WalletRuntimeBoundary>
  );
  if (view === "demo") return <Suspense fallback={<main className="app-canvas flex min-h-screen items-center justify-center text-sm text-slate-500">{t("Opening evidence demo…", "Đang mở demo bằng chứng…")}</main>}><DemoWorkspace onConnect={() => setView("wallet")} onExit={() => setView("landing")} /></Suspense>;
  return <Landing onConnect={() => setView("wallet")} onDemo={() => setView("demo")} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <ShelbyNetworkProvider>
        <Bootstrap />
        <Toaster />
      </ShelbyNetworkProvider>
    </LanguageProvider>
  </React.StrictMode>,
);
