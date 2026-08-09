import { PropsWithChildren } from "react";
import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
// Internal components
import { useToast } from "@/components/ui/use-toast";
import { useLanguage } from "@/i18n";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";
import { getShelbyClientKeyResult } from "@/utils/geomiClientKey";
import { toAptosNetwork } from "@/utils/shelbyNetwork";

export function WalletProvider({ children }: PropsWithChildren) {
  const { toast } = useToast();
  const { t } = useLanguage();
  const { network } = useShelbyNetwork();
  const aptosNetwork = toAptosNetwork(network);
  const apiKey = getShelbyClientKeyResult(network).key || undefined;
  // wallet-adapter-react 6.2.0 bundles an Aptos Connect client whose Network
  // enum predates ShelbyNet. Passing "shelbynet" as dappConfig crashes the
  // provider during construction. Extension wallets can still connect; the
  // workspace independently verifies the wallet-reported network before any
  // Shelby read or signature is enabled.
  const dappConfig = network === "testnet"
    ? { network: aptosNetwork as any, aptosApiKeys: apiKey ? { [aptosNetwork]: apiKey } : undefined }
    : undefined;

  return (
    <AptosWalletAdapterProvider
      autoConnect={true}
      dappConfig={dappConfig}
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
