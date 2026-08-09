import { WalletSelector } from "./WalletSelector";
import { Database, Presentation } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { useLanguage } from "@/i18n";
import { NetworkSelector } from "@/components/NetworkSelector";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";
import { shelbyNetworkLabel } from "@/utils/shelbyNetwork";

export function Header({ onOpenProductTour }: { onOpenProductTour?: () => void }) {
  const { t } = useLanguage();
  const { network } = useShelbyNetwork();
  return (
    <header className="mx-auto mt-2.5 w-[calc(100%-16px)] max-w-[1600px] rounded-2xl border border-[#dfe4dc] bg-[#fbfcf8]/95 shadow-[0_1px_2px_rgba(15,23,18,.03),0_10px_35px_rgba(15,23,18,.045)] backdrop-blur-xl dark:border-white/[0.075] dark:bg-[#101713]/95 dark:shadow-black/20 transition-all duration-300">
      <div className="flex min-h-[52px] w-full items-center justify-between gap-1.5 px-2.5 py-1.5 sm:gap-3 sm:px-4">
        {/* Left: Logo + name */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#151c17] text-[#c4fa7b] shadow-[0_0_15px_rgba(196,250,123,0.2)] dark:bg-[#c2f779] dark:text-[#101713] dark:shadow-[0_0_20px_rgba(194,247,121,0.25)] relative glow-border">
            <Database className="h-[18px] w-[18px] relative z-10" />
          </div>
          <div>
            <div className="flex items-center gap-2"><h1 className="whitespace-nowrap text-[14px] font-extrabold tracking-[-0.025em] text-[#101512] dark:text-white"><span className="max-[359px]:hidden">Shelby RAG Explorer</span><span className="min-[360px]:hidden">Shelby</span></h1><span className="hidden text-[#cbd2ca] sm:inline dark:text-white/15">/</span><span className="hidden text-[12px] font-medium text-[#788079] sm:inline">{t("Knowledge workspace", "Kho tri thức")}</span></div>
            <div className="mt-0.5 hidden items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-700 dark:text-lime-300 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{shelbyNetworkLabel(network)} · {t("active", "đang hoạt động")}</div>
          </div>
        </div>

        {/* Right: Theme + Wallet */}
        <div className="flex min-w-0 items-center gap-1.5">
          {onOpenProductTour && (
            <button
              type="button"
              onClick={onOpenProductTour}
              className="hidden h-9 items-center gap-1.5 rounded-xl border border-emerald-200/80 bg-emerald-50/70 px-2.5 text-[10px] font-extrabold text-emerald-800 transition hover:-translate-y-0.5 hover:border-emerald-300 hover:bg-emerald-50 dark:border-lime-300/15 dark:bg-lime-300/[0.06] dark:text-lime-300 min-[360px]:flex"
              aria-label={t("Open product tour", "Mở hướng dẫn sản phẩm")}
            >
              <Presentation className="h-3.5 w-3.5" /><span className="hidden md:inline">{t("Product tour", "Hướng dẫn")}</span>
            </button>
          )}
          <div className="hidden md:block"><NetworkSelector walletAware compact /></div>
          <LanguageToggle />
          <div className="hidden sm:block"><ThemeToggle /></div>
          <div className="min-w-0 max-w-[6.5rem] sm:max-w-[9rem]">
            <WalletSelector />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-900/[0.06] px-2.5 py-1.5 dark:border-white/[0.06] md:hidden">
        <NetworkSelector walletAware compact />
        {network === "shelbynet" && <span className="truncate text-[9px] font-semibold text-amber-700 dark:text-amber-300">{t("Developer network · data may reset", "Mạng developer · dữ liệu có thể reset")}</span>}
      </div>
    </header>
  );
}
