import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/i18n";

type ThemeMode = "light" | "dark";
const STORAGE_KEY = "shelby-rag-explorer.theme";

function readTheme(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(readTheme);
  const { t } = useLanguage();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Theme remains usable in-memory when browser storage is blocked.
    }
  }, [mode]);

  return (
    <div className="relative flex items-center rounded-full border border-slate-200/80 bg-white/70 p-1 shadow-sm dark:border-white/10 dark:bg-white/[0.05]" aria-label={t("Choose appearance", "Chọn giao diện")}>
      <div
        className="absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-full bg-slate-900 dark:bg-white transition-all duration-300 ease-out"
        style={{ left: mode === "light" ? "4px" : "calc(50%)" }}
      />
      <Button size="sm" variant="ghost" className={`relative z-10 h-7 rounded-full px-2 transition-colors ${mode === "light" ? "text-white dark:text-slate-950" : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/[0.08]"}`} onClick={() => setMode("light")} aria-label={t("Light theme", "Giao diện sáng")}><Sun className={`h-3.5 w-3.5 transition-transform duration-500 ${mode === "light" ? "rotate-90" : "rotate-0"}`} /></Button>
      <Button size="sm" variant="ghost" className={`relative z-10 h-7 rounded-full px-2 transition-colors ${mode === "dark" ? "text-white dark:text-slate-950" : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/[0.08]"}`} onClick={() => setMode("dark")} aria-label={t("Dark theme", "Giao diện tối")}><Moon className={`h-3.5 w-3.5 transition-transform duration-500 ${mode === "dark" ? "rotate-[360deg]" : "rotate-0"}`} /></Button>
    </div>
  );
}
