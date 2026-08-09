import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";
import { isE2EWalletConnected, isMockWorkspace } from "@/utils/devMode";
import { isShelbyNetworkAvailable, isWalletNetworkMatch } from "@/utils/shelbyNetwork";

export function useWalletNetworkReady(): boolean {
  const { connected, network: walletNetwork } = useWallet();
  const { network } = useShelbyNetwork();
  if (!isShelbyNetworkAvailable(network)) return false;
  if (isE2EWalletConnected() || isMockWorkspace()) return true;
  return !connected || isWalletNetworkMatch(walletNetwork, network);
}
