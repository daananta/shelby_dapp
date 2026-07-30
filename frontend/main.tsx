import "../vite.polyfills";
import "./index.css";

import React, { Suspense, lazy, useState } from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "@/components/ui/toaster.tsx";
import { Landing } from "@/components/Landing";
import { LanguageProvider, useLanguage } from "@/i18n";

const WalletWorkspace = lazy(() => import("@/WalletWorkspace"));
const DemoWorkspace = lazy(() => import("@/DemoWorkspace"));

function Bootstrap() {
  const [view, setView] = useState<"landing" | "wallet" | "demo">("landing");
  const { t } = useLanguage();
  if (view === "wallet") return (
    <Suspense fallback={<main className="app-canvas flex min-h-screen items-center justify-center text-sm text-slate-500">{t("Opening Shelby workspace…", "Đang mở kết nối Shelby…")}</main>}>
      <WalletWorkspace onOpenDemo={() => setView("demo")} />
    </Suspense>
  );
  if (view === "demo") return <Suspense fallback={<main className="app-canvas flex min-h-screen items-center justify-center text-sm text-slate-500">{t("Opening evidence demo…", "Đang mở demo bằng chứng…")}</main>}><DemoWorkspace onConnect={() => setView("wallet")} onExit={() => setView("landing")} /></Suspense>;
  return <Landing onConnect={() => setView("wallet")} onDemo={() => setView("demo")} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <Bootstrap />
      <Toaster />
    </LanguageProvider>
  </React.StrictMode>,
);
