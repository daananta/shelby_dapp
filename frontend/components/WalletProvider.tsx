import { PropsWithChildren } from "react";
import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
// Internal components
import { useToast } from "@/components/ui/use-toast";
// Internal constants
import { APTOS_API_KEY, NETWORK } from "@/constants";
import { useLanguage } from "@/i18n";

export function WalletProvider({ children }: PropsWithChildren) {
  const { toast } = useToast();
  const { t } = useLanguage();

  return (
    <AptosWalletAdapterProvider
      autoConnect={true}
      dappConfig={{ network: NETWORK, aptosApiKeys: {[NETWORK]: APTOS_API_KEY} }}
      onError={(error) => {
        toast({
          variant: "destructive",
          title: t("Unable to connect wallet", "Không thể kết nối ví"),
          description: error || t("The wallet returned an unknown error. Try again or choose another wallet.", "Ví trả về lỗi không xác định. Hãy thử lại hoặc chọn ví khác."),
        });
      }}
    >
      {children}
    </AptosWalletAdapterProvider>
  );
}
