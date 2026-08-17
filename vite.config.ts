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
  const shelbyClientKeyVariables = ["VITE_SHELBYNET_CLIENT_API_KEY", "VITE_TESTNET_CLIENT_API_KEY", "VITE_SHELBY_CLIENT_API_KEY"];
  for (const variable of shelbyClientKeyVariables) {
    const shelbyClientKey = env[variable]?.trim().replace(/^["']|["']$/g, "") ?? "";
    if (shelbyClientKey && !/^AG-\S+$/i.test(shelbyClientKey)) {
      throw new Error(`Từ chối build: ${variable} chỉ nhận Geomi client key công khai có prefix AG-. Không dùng server key aptoslabs_ trong frontend.`);
    }
  }

  Object.assign(process.env, env);

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
    {
      name: "api-dev-server",
      configureServer(server: any) {
        server.middlewares.use(async (req: any, res: any, next: any) => {
          const url = req.url ? new URL(req.url, "http://localhost").pathname : "";
          if (url === "/api/ai/v1/chat" || url === "/api/rag/v1/embeddings") {
            try {
              let rawBody = "";
              for await (const chunk of req) {
                rawBody += chunk;
              }
              let body = {};
              if (rawBody) {
                try {
                  body = JSON.parse(rawBody);
                } catch {
                  body = {};
                }
              }
              const requestLike = {
                method: req.method,
                headers: req.headers,
                body,
                socket: req.socket,
              };
              const responseLike = {
                statusCode: 200,
                setHeader(name: string, value: string) {
                  res.setHeader(name, value);
                },
                status(code: number) {
                  this.statusCode = code;
                  res.statusCode = code;
                  return this;
                },
                json(data: unknown) {
                  if (!res.headersSent) {
                    res.setHeader("Content-Type", "application/json");
                    res.statusCode = this.statusCode;
                  }
                  res.end(JSON.stringify(data));
                },
                write(chunk: unknown) {
                  if (!res.headersSent) {
                    res.writeHead(this.statusCode || 200);
                    res.flushHeaders?.();
                  }
                  const ok = res.write(chunk);
                  res.flush?.();
                  return ok;
                },
                end(data?: unknown) {
                  return res.end(data);
                },
              };

              if (url === "/api/ai/v1/chat") {
                const chatModule = await server.ssrLoadModule("./api/ai/v1/chat.ts");
                await chatModule.default(requestLike, responseLike);
                return;
              }
              if (url === "/api/rag/v1/embeddings") {
                const embModule = await server.ssrLoadModule("./api/rag/v1/embeddings.ts");
                await embModule.default(requestLike, responseLike);
                return;
              }
            } catch (err) {
              console.error("Vite API dev server error:", err);
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Internal dev server error" }));
              }
              return;
            }
          }
          next();
        });
      },
    },
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
