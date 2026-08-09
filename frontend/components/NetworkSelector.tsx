import { useCallback } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { ChevronDown, Network } from "lucide-react";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";
import { useToast } from "@/components/ui/use-toast";
import { useLanguage } from "@/i18n";
import {
  getShelbyNetworkCapabilities,
  isWalletNetworkMatch,
  isShelbyNetworkAvailable,
  shelbyNetworkLabel,
  toAptosNetwork,
  type SupportedShelbyNetwork,
} from "@/utils/shelbyNetwork";

interface NetworkSelectorProps {
  walletAware?: boolean;
  compact?: boolean;
}

function SelectorView({ onSelect, compact = false }: { onSelect: (network: SupportedShelbyNetwork) => Promise<void> | void; compact?: boolean }) {
  const { network, busy } = useShelbyNetwork();
  const { t } = useLanguage();
  return (
    <label className="relative inline-flex min-w-0 items-center">
      <Network className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-emerald-700 dark:text-lime-300" />
      <select
        aria-label={t("Shelby network", "Mạng Shelby")}
        value={network}
        disabled={busy}
        onChange={(event) => void onSelect(event.target.value as SupportedShelbyNetwork)}
        className={`h-9 appearance-none rounded-xl border border-emerald-200/80 bg-emerald-50/70 pl-8 pr-7 text-[11px] font-extrabold text-emerald-900 outline-none transition hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-lime-300/15 dark:bg-lime-300/[0.06] dark:text-lime-200 ${compact ? "max-w-[9.25rem]" : "max-w-[12.5rem]"}`}
        title={network === "shelbynet" ? t("Developer network; data may be reset", "Mạng dành cho developer; dữ liệu có thể được reset") : t("Shelby public test network", "Mạng thử nghiệm công khai của Shelby")}
      >
        <option value="shelbynet">{compact ? "ShelbyNet" : "ShelbyNet · Developer"}</option>
        <option value="testnet" disabled>
          {t("Shelby Testnet · Temporarily unavailable", "Shelby Testnet · Tạm ngưng")}
        </option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-emerald-700 dark:text-lime-300" />
    </label>
  );
}

function WalletAwareSelector({ compact }: { compact?: boolean }) {
  const select = useWalletAwareShelbyNetworkSwitch();
  return <SelectorView compact={compact} onSelect={select} />;
}

export function useWalletAwareShelbyNetworkSwitch() {
  const { network: activeNetwork, requestNetwork, busy } = useShelbyNetwork();
  const { connected, network: walletNetwork, changeNetwork } = useWallet();
  const { toast } = useToast();
  const { t } = useLanguage();

  return useCallback(async (next: SupportedShelbyNetwork) => {
    if (next === activeNetwork) return;
    if (!isShelbyNetworkAvailable(next)) {
      toast({
        title: t("Shelby Testnet is temporarily unavailable", "Shelby Testnet đang tạm ngưng"),
        description: t("Your previous Testnet data is preserved for when the network reopens.", "Dữ liệu Testnet cũ vẫn được giữ lại để dùng khi mạng mở lại."),
      });
      return;
    }
    if (busy) {
      toast({ title: t("Finish the current operation first", "Hãy hoàn tất thao tác hiện tại"), description: t("The network is locked during RAG, upload, sync, or restore.", "Không thể đổi mạng khi đang tạo RAG, tải lên, đồng bộ hoặc khôi phục.") });
      return;
    }
    if (connected && !isWalletNetworkMatch(walletNetwork, next)) {
      if (typeof changeNetwork !== "function") {
        toast({
          variant: "destructive",
          title: t("Switch the network in your wallet", "Hãy đổi mạng trong ví"),
          description: t(`Your wallet does not support automatic switching to ${shelbyNetworkLabel(next)}.`, `Ví không hỗ trợ tự chuyển sang ${shelbyNetworkLabel(next)}.`),
        });
        return;
      }
      try {
        await changeNetwork(toAptosNetwork(next) as any);
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Network change was cancelled", "Đã huỷ đổi mạng"),
          description: error instanceof Error ? error.message : t("The app kept the previous network.", "Ứng dụng vẫn giữ mạng cũ."),
        });
        return;
      }
    }
    if (!requestNetwork(next)) {
      toast({ title: t("Finish the current operation first", "Hãy hoàn tất thao tác hiện tại"), description: t("The network is locked during RAG, upload, sync, or restore.", "Không thể đổi mạng khi đang tạo RAG, tải lên, đồng bộ hoặc khôi phục.") });
    }
  }, [activeNetwork, busy, changeNetwork, connected, requestNetwork, t, toast, walletNetwork?.chainId, walletNetwork?.name, walletNetwork?.url]);
}

export function NetworkSelector({ walletAware = false, compact = false }: NetworkSelectorProps) {
  const { requestNetwork } = useShelbyNetwork();
  if (walletAware) return <WalletAwareSelector compact={compact} />;
  return <SelectorView compact={compact} onSelect={(network) => {
    if (getShelbyNetworkCapabilities(network).availability === "active") requestNetwork(network);
  }} />;
}
