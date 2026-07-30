import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "@/App";
import { WalletProvider } from "@/components/WalletProvider";
import { WrongNetworkAlert } from "@/components/WrongNetworkAlert";

const queryClient = new QueryClient();

interface WalletWorkspaceProps {
  onOpenDemo?: () => void;
}

/** Loaded only after the visitor asks to connect a wallet. */
export default function WalletWorkspace({ onOpenDemo }: WalletWorkspaceProps) {
  return (
    <WalletProvider>
      <QueryClientProvider client={queryClient}>
        <div data-testid="wallet-runtime">
          <App onOpenDemo={onOpenDemo} />
          <WrongNetworkAlert />
        </div>
      </QueryClientProvider>
    </WalletProvider>
  );
}
