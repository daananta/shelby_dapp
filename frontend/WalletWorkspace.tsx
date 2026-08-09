import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ShelbyClientProvider } from "@shelby-protocol/react";
import { useEffect, useMemo } from "react";
import App from "@/App";
import { WalletProvider } from "@/components/WalletProvider";
import { WrongNetworkAlert } from "@/components/WrongNetworkAlert";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";
import { getShelbyRuntime } from "@/utils/shelbyConfig";

interface WalletWorkspaceProps {
  onOpenDemo?: () => void;
}

/** Loaded only after the visitor asks to connect a wallet. */
export default function WalletWorkspace({ onOpenDemo }: WalletWorkspaceProps) {
  const { network } = useShelbyNetwork();
  const queryClient = useMemo(() => new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false } },
  }), [network]);
  const client = useMemo(() => getShelbyRuntime(network).client, [network]);
  useEffect(() => () => queryClient.clear(), [queryClient]);
  return (
    <WalletProvider key={network}>
      <QueryClientProvider client={queryClient}>
        <ShelbyClientProvider client={client}>
          <div data-testid="wallet-runtime" data-shelby-network={network}>
            <App onOpenDemo={onOpenDemo} />
            <WrongNetworkAlert />
          </div>
        </ShelbyClientProvider>
      </QueryClientProvider>
    </WalletProvider>
  );
}
