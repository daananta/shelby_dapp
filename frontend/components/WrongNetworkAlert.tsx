import { NETWORK } from "@/constants";
import { useLanguage } from "@/i18n";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { LogOut, Network } from "lucide-react";

export function WrongNetworkAlert() {
  const { t } = useLanguage();
  const { network, connected, disconnect } = useWallet();

  return !connected || network?.name === NETWORK ? (
    <></>
  ) : (
    <Dialog.Root open={true}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ease-in-out" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 shadow-2xl rounded-2xl border border-slate-200 p-6 bg-white dark:border-white/10 dark:bg-slate-900 transition-transform duration-300 ease-in-out w-[90vw] max-w-md">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-300/10 dark:text-amber-300"><Network className="h-5 w-5" /></div>
            <Dialog.Title className="text-xl font-extrabold mb-2 text-gray-900 dark:text-gray-100">
              {t("Wallet is on the wrong network", "Ví đang ở sai mạng")}
            </Dialog.Title>
            <Dialog.Description className="text-sm leading-6 text-gray-600 dark:text-gray-300">
              {t("Your wallet is currently on ", "Ví hiện đang ở ")}
              <span className="font-bold">{network?.name ?? t("another network", "mạng khác")}</span>.
              {" "}
              {t("Open your wallet and switch to ", "Hãy mở ví và chuyển sang ")}
              <span className="font-bold">{NETWORK}</span>;
              {" "}
              {t("the app will continue automatically when the network matches.", "ứng dụng sẽ tự tiếp tục khi nhận đúng mạng.")}
            </Dialog.Description>
            <Button variant="outline" className="mt-5 rounded-xl" onClick={() => void disconnect()}><LogOut className="mr-2 h-4 w-4" />{t("Disconnect wallet", "Ngắt kết nối ví")}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
