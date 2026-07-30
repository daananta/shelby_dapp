import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const forbiddenClientSecrets = Object.keys(env).filter((name) =>
    name.startsWith("VITE_") && /(PRIVATE_KEY|SECRET|SPONSOR|GEMINI_API_KEY|OPENROUTER_API_KEY)/i.test(name),
  );
  if (forbiddenClientSecrets.length) {
    throw new Error(`Từ chối build: secret không được dùng tiền tố VITE_: ${forbiddenClientSecrets.join(", ")}`);
  }
  const shelbyClientKey = env.VITE_SHELBY_CLIENT_API_KEY?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (shelbyClientKey && !/^AG-\S+$/i.test(shelbyClientKey)) {
    throw new Error("Từ chối build: VITE_SHELBY_CLIENT_API_KEY chỉ nhận Geomi client key công khai có prefix AG-. Không dùng server key aptoslabs_ trong frontend.");
  }

  return ({
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks: {
          "aptos-wallet": ["@aptos-labs/ts-sdk", "@aptos-labs/wallet-adapter-react"],
          "rag-search": ["@orama/orama"],
        },
      },
    },
  },
  worker: { format: "es" },
  server: {
    open: true,
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./frontend"),
      buffer: 'buffer',
      process: 'process/browser',
      stream: 'stream-browserify',
      util: 'util',
    },
  },
  optimizeDeps: {
    // clay-codes resolves clay.wasm relative to import.meta.url. Prebundling
    // moves that JS into .vite/deps without its WASM sibling and returns the
    // SPA HTML fallback instead. Serve these packages from their real paths.
    exclude: ["@shelby-protocol/sdk", "@shelby-protocol/clay-codes"],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  });
});
