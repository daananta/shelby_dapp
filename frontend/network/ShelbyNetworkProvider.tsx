import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  getShelbyNetworkCapabilities,
  getStoredShelbyNetwork,
  isShelbyNetworkAvailable,
  persistShelbyNetwork,
  resolveOperationalShelbyNetwork,
  type ShelbyNetworkCapabilities,
  type SupportedShelbyNetwork,
} from "@/utils/shelbyNetwork";

interface ShelbyNetworkContextValue {
  network: SupportedShelbyNetwork;
  capabilities: ShelbyNetworkCapabilities;
  busy: boolean;
  requestNetwork: (network: SupportedShelbyNetwork) => boolean;
  setOperationBusy: (id: string, active: boolean) => void;
}

const ShelbyNetworkContext = createContext<ShelbyNetworkContextValue | null>(null);

export function ShelbyNetworkProvider({ children }: PropsWithChildren) {
  const [selectedNetwork, setSelectedNetwork] = useState<SupportedShelbyNetwork>(getStoredShelbyNetwork);
  // Keep the context fail-closed even when React Fast Refresh preserves an old
  // Testnet state after the network capability table changes.
  const network = resolveOperationalShelbyNetwork(selectedNetwork);
  const operationsRef = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selectedNetwork === network) return;
    persistShelbyNetwork(network);
    setSelectedNetwork(network);
  }, [network, selectedNetwork]);

  const setOperationBusy = useCallback((id: string, active: boolean) => {
    if (active) operationsRef.current.add(id);
    else operationsRef.current.delete(id);
    setBusy(operationsRef.current.size > 0);
  }, []);

  const requestNetwork = useCallback((next: SupportedShelbyNetwork) => {
    if (operationsRef.current.size > 0) return false;
    if (!isShelbyNetworkAvailable(next)) return false;
    if (next === network) return true;
    window.dispatchEvent(new CustomEvent("shelby:network-changing", { detail: { from: network, to: next } }));
    persistShelbyNetwork(next);
    setSelectedNetwork(next);
    return true;
  }, [network]);

  const capabilities = getShelbyNetworkCapabilities(network);
  const value = useMemo(() => ({ network, capabilities, busy, requestNetwork, setOperationBusy }), [network, capabilities, busy, requestNetwork, setOperationBusy]);
  return <ShelbyNetworkContext.Provider value={value}>{children}</ShelbyNetworkContext.Provider>;
}

export function useShelbyNetwork() {
  const context = useContext(ShelbyNetworkContext);
  if (!context) throw new Error("useShelbyNetwork must be used inside ShelbyNetworkProvider");
  return context;
}

export function useShelbyNetworkOperation(id: string, active: boolean) {
  const { setOperationBusy } = useShelbyNetwork();
  useEffect(() => {
    setOperationBusy(id, active);
    return () => setOperationBusy(id, false);
  }, [active, id, setOperationBusy]);
}
