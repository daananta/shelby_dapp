import { SHELBY_CLIENT_API_KEY } from "@/utils/geomiClientKey";

export const NETWORK = import.meta.env.VITE_APP_NETWORK ?? "testnet";
export const APTOS_API_KEY = SHELBY_CLIENT_API_KEY || undefined;
