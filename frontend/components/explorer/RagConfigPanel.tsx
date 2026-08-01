import { RAG_GATEWAY_URL, type EmbeddingProvider } from "@/utils/embeddingClient";
import { summarizeRagSources } from "@/utils/ragMetrics";
import { assessRagQuality } from "@/utils/ragQuality";
import { type RagSource } from "@/utils/ragOrama";
import { ScanText, FileText, LayoutTemplate, Layers, Network, AlertCircle, Video, ShieldCheck, MessageSquareText, BrainCircuit, Gauge } from "lucide-react";
import { useGeminiUsage } from "@/hooks/useGeminiUsage";
import { useLanguage } from "@/i18n";

interface RagConfigPanelProps {
  fullPdfOcr: boolean;
  setFullPdfOcr: React.Dispatch<React.SetStateAction<boolean>>;
  embeddingMode: EmbeddingProvider;
  setEmbeddingMode: React.Dispatch<React.SetStateAction<EmbeddingProvider>>;
  ragChunkSize: number;
  setRagChunkSize: React.Dispatch<React.SetStateAction<number>>;
  ragSources: RagSource[];
}

export function RagConfigPanel({
  fullPdfOcr,
  setFullPdfOcr,
  embeddingMode,
  setEmbeddingMode,
  ragChunkSize,
  setRagChunkSize,
  ragSources
}: RagConfigPanelProps) {
  const { t } = useLanguage();
  const { preferences: geminiUsage, setPreference } = useGeminiUsage();
  const ragMetrics = summarizeRagSources(ragSources);
  const ragQuality = assessRagQuality(ragSources);

  const usageSwitch = (enabled: boolean, label: string, onClick: () => void) => (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onClick}
      className={`relative h-6 w-12 shrink-0 rounded-full transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${enabled ? "bg-gradient-to-r from-emerald-700 to-emerald-500 dark:from-lime-400 dark:to-lime-300" : "bg-slate-300 dark:bg-slate-700"}`}
    >
      <span className={`absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-300 dark:bg-slate-950 ${enabled ? "translate-x-6" : "translate-x-0"}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${enabled ? "bg-emerald-500 dark:bg-lime-400" : "bg-slate-300 dark:bg-slate-700"}`} />
      </span>
    </button>
  );

  return (
    <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out">
      <div className="overflow-hidden rounded-xl border border-emerald-200/80 bg-gradient-to-br from-emerald-50/80 to-lime-50/40 dark:border-emerald-300/10 dark:from-emerald-300/[0.055] dark:to-transparent">
        <div className="flex items-start gap-3 border-b border-emerald-200/60 px-4 py-3.5 dark:border-emerald-300/10">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#172019] text-[#c5fb7e] dark:bg-lime-300 dark:text-slate-950"><Gauge className="h-4 w-4" /></div>
          <div>
            <h4 className="text-sm font-extrabold text-slate-900 dark:text-white">{t("Manage AI features", "Quản lý tính năng AI")}</h4>
            <p className="mt-1 text-[11px] leading-4 text-slate-600 dark:text-slate-400">{t("Chat uses Gemini when you save a key; without one, the app provides Qwen3.7 Flash. The other switches control RAG processing.", "Chat dùng Gemini khi bạn lưu key; nếu chưa có key, ứng dụng cung cấp Qwen3.7 Flash. Các công tắc còn lại điều khiển việc xử lý RAG.")}</p>
          </div>
        </div>
        <div className="divide-y divide-emerald-100/80 px-3 dark:divide-white/[0.055]">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 items-start gap-2.5"><MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-lime-300" /><div><strong className="block text-xs text-slate-800 dark:text-slate-200">{t("AI chat", "Trò chuyện với AI")}</strong><p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{t("A saved Gemini key uses Gemini with 2.5 Flash preferred; otherwise chat uses Qwen3.7 Flash.", "Có Gemini key thì ưu tiên Gemini 2.5 Flash; nếu chưa có, chat dùng Qwen3.7 Flash.")}</p></div></div>
            {usageSwitch(geminiUsage.chat, t("Enable AI chat", "Bật trò chuyện với AI"), () => setPreference("chat", !geminiUsage.chat))}
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 items-start gap-2.5"><ScanText className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-lime-300" /><div><strong className="block text-xs text-slate-800 dark:text-slate-200">{t("Read images, PDFs, and videos", "Đọc ảnh, PDF và video")}</strong><p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{t("Used only while building RAG. Chat can still inspect an indexed image when you ask. When off, PDFs use on-device OCR and videos wait.", "Chỉ dùng khi tạo RAG. Khi chat, AI vẫn có thể xem ảnh đã index nếu bạn yêu cầu. Khi tắt, PDF dùng OCR trên máy và video sẽ chờ.")}</p></div></div>
            {usageSwitch(geminiUsage.contentAnalysis, t("Use Gemini to read content while building RAG", "Dùng Gemini để đọc nội dung khi tạo RAG"), () => setPreference("contentAnalysis", !geminiUsage.contentAnalysis))}
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 items-start gap-2.5"><BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-lime-300" /><div><strong className="block text-xs text-slate-800 dark:text-slate-200">{t("Semantic search", "Tìm theo ý nghĩa")}</strong><p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{t("Creates embeddings in batches of up to 20 chunks and a vector for each query. When off, RAG still works with keyword search.", "Tạo embeddings theo lô tối đa 20 chunks và vector cho câu tra cứu. Khi tắt, RAG vẫn tìm được bằng từ khóa.")}</p></div></div>
            {usageSwitch(geminiUsage.semanticSearch, t("Enable semantic search", "Tạo tìm kiếm theo ý nghĩa"), () => setPreference("semanticSearch", !geminiUsage.semanticSearch))}
          </div>
          <div className="flex items-start gap-2.5 py-3 text-[11px] leading-4 text-slate-600 dark:text-slate-400">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-lime-300" />
            <p>{t(
              "For AI chat, your question and only the retrieved excerpts or indexed image needed for that answer are sent to Gemini or Qwen. API keys are never stored in RAG or uploaded to Shelby.",
              "Khi chat AI, câu hỏi và chỉ các đoạn trích hoặc ảnh đã index cần cho câu trả lời được gửi tới Gemini hoặc Qwen. API key không được lưu trong RAG hay tải lên Shelby.",
            )}</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-white/10 dark:bg-slate-950/20">
        <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-3">{t("Knowledge base settings", "Cách tạo kho tri thức")}</h4>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.025] hover-lift">
            <div className="flex min-w-0 items-start gap-2.5 text-xs text-slate-600 dark:text-slate-400">
              <ScanText className="mt-0.5 h-4 w-4 shrink-0 text-[#487450] dark:text-lime-300" />
              <div>
                <strong className="mb-1 block text-slate-800 dark:text-slate-200">{t("OCR every PDF page", "OCR toàn bộ PDF")}</strong>
                {fullPdfOcr
                  ? t("Reads every page again with OCR. Best for scanned PDFs, but slower and uses more quota.", "Đọc lại mọi trang bằng OCR; phù hợp PDF scan nhưng chậm và tốn quota hơn.")
                  : t("Smart mode: only OCRs the cover and pages with little or no text.", "Chế độ thông minh: chỉ OCR bìa và trang có ít hoặc không có text.")}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={fullPdfOcr}
              aria-label={t("OCR every PDF page", "OCR toàn bộ PDF")}
              onClick={() => setFullPdfOcr((value) => !value)}
              className={`relative h-6 w-12 shrink-0 rounded-full transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-500 focus-visible:ring-offset-2 ${fullPdfOcr ? "bg-gradient-to-r from-[#315f3e] to-[#487450] dark:from-lime-400 dark:to-lime-300" : "bg-slate-300 dark:bg-slate-700"}`}
            >
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-300 flex items-center justify-center dark:bg-slate-950 ${fullPdfOcr ? "translate-x-6 w-5" : "translate-x-0 w-5"}`}>
                <div className={`h-2.5 w-2.5 rounded-full transition-colors ${fullPdfOcr ? "bg-emerald-500 dark:bg-lime-400" : "bg-slate-300 dark:bg-slate-700"}`} />
              </span>
            </button>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="rag-embedding-source" className="text-xs font-bold text-slate-700 dark:text-slate-300">{t("Semantic search provider", "Nguồn tạo tìm kiếm theo ý nghĩa")}</label>
            <select
              id="rag-embedding-source"
              value={embeddingMode}
              onChange={(event) => setEmbeddingMode(event.target.value as EmbeddingProvider)}
              disabled={!geminiUsage.semanticSearch}
              className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-800 transition-colors hover:border-slate-300 focus:ring-2 focus:ring-lime-500/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 dark:border-white/10 dark:bg-slate-950 dark:text-slate-100 dark:hover:border-slate-600 dark:disabled:bg-white/[0.025]"
            >
              <option value="gemini">{t("Semantic search with Gemini (uses your key)", "Tìm theo ý nghĩa với Gemini (dùng key của bạn)")}</option>
              <option value="gateway" disabled={!RAG_GATEWAY_URL}>{t(`Semantic search through the app server${RAG_GATEWAY_URL ? "" : " (not configured)"}`, `Tìm theo ý nghĩa qua máy chủ ứng dụng${RAG_GATEWAY_URL ? "" : " (chưa cấu hình)"}`)}</option>
            </select>
            <p className="text-[11px] leading-4 text-slate-500 dark:text-slate-400">
              {geminiUsage.semanticSearch
                ? t("Each chunk is sent to the provider you choose. Turn off the switch above to use browser-only keyword search.", "Nội dung từng chunk sẽ được gửi đến nguồn bạn chọn. Tắt công tắc phía trên để chỉ tìm bằng từ khóa trong trình duyệt.")
                : t("Using on-device keyword search: no embeddings are created and no Gemini quota is used.", "Đang dùng tìm kiếm từ khóa trên thiết bị: không tạo embedding và không dùng quota Gemini.")}
            </p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="rag-chunk-size" className="text-xs font-bold text-slate-700 dark:text-slate-300">{t("Chunk size", "Kích thước chunk")}</label>
            <select
              id="rag-chunk-size"
              value={ragChunkSize}
              onChange={(event) => setRagChunkSize(Number(event.target.value))}
              className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs dark:border-white/10 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition-colors hover:border-slate-300 dark:hover:border-slate-600 focus:ring-2 focus:ring-lime-500/20"
            >
              <option value={800}>{t("800 characters · detailed retrieval", "800 ký tự · truy hồi chi tiết")}</option>
              <option value={1200}>{t("1200 characters · balanced (recommended)", "1200 ký tự · cân bằng (khuyên dùng)")}</option>
              <option value={1600}>{t("1600 characters · more context", "1600 ký tự · giữ nhiều ngữ cảnh")}</option>
            </select>
            <p className="text-[11px] leading-4 text-slate-500 dark:text-slate-400">
              {t("Bigger is not always better. Small chunks match details more precisely but create more vectors; large chunks preserve context but may dilute the answer. The 1200-character default works well for most documents.", "Không có kích thước “càng lớn càng tốt”. Chunk nhỏ dễ khớp đúng một chi tiết nhưng tạo nhiều vector; chunk lớn giữ mạch văn tốt hơn nhưng có thể pha loãng câu trả lời. Mặc định 1200 phù hợp đa số tài liệu.")}
            </p>
          </div>

          <div className="rounded-xl border border-sky-100 bg-sky-50/60 p-3 dark:border-sky-300/10 dark:bg-sky-300/[0.035]">
            <div className="flex items-start gap-2.5">
              <Video className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
              <div>
                <strong className="block text-xs text-slate-800 dark:text-slate-200">{t("MP4 video processing", "Xử lý video MP4")}</strong>
                <p className="mt-1 text-[11px] leading-4 text-slate-600 dark:text-slate-400">{t("Gemini reads speech, text, and visuals in the video to create searchable content. The browser version currently supports videos up to 18 MB.", "Gemini đọc lời nói, chữ và hình ảnh trong video để tạo nội dung có thể tìm kiếm. Bản trình duyệt hiện hỗ trợ video tối đa 18 MB.")}</p>
              </div>
            </div>
            <div className="mt-2.5 flex items-start gap-2 border-t border-sky-100 pt-2.5 dark:border-sky-300/10">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
              <p className="text-[10px] leading-4 text-slate-500 dark:text-slate-400">{t("Your API key stays in this browser tab and is never packaged into RAG or uploaded to Shelby.", "API key chỉ được giữ trong phiên tab và không được đóng gói vào RAG hoặc tải lên Shelby.")}</p>
            </div>
          </div>
        </div>
      </div>

      {ragSources.length > 0 && (
        <div className={`rounded-xl border p-4 ${ragQuality.state === "ready" ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-300/10 dark:bg-emerald-400/[0.02]" : "border-amber-200 bg-amber-50/40 dark:border-amber-300/10 dark:bg-amber-400/[0.02]"}`}>
          <div className="mb-3 flex items-center justify-between">
            <span className={`text-xs font-bold uppercase tracking-wider ${ragQuality.state === "ready" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{t("RAG quality", "Chất lượng RAG")}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${ragQuality.state === "ready" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"}`}>{ragQuality.state === "ready" ? t("Ready", "Sẵn sàng") : t("Attention", "Cảnh báo")}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center text-xs">
            <div className="rounded-lg bg-white/80 p-2.5 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 relative overflow-hidden group hover-lift">
              <FileText className="absolute -right-2 -top-2 h-10 w-10 text-slate-100 dark:text-white/[0.02] transition-transform group-hover:scale-110" />
              <strong className="block text-sm text-slate-800 dark:text-slate-100 relative z-10">{ragMetrics.documents}</strong>
              <span className="relative z-10">{t("Documents", "Tài liệu")}</span>
            </div>
            <div className="rounded-lg bg-white/80 p-2.5 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 relative overflow-hidden group hover-lift">
              <LayoutTemplate className="absolute -right-2 -top-2 h-10 w-10 text-slate-100 dark:text-white/[0.02] transition-transform group-hover:scale-110" />
              <strong className="block text-sm text-slate-800 dark:text-slate-100 relative z-10">{ragMetrics.pages}</strong>
              <span className="relative z-10">{t("Indexed pages", "Trang đã lập chỉ mục")}</span>
            </div>
            <div className="rounded-lg bg-white/80 p-2.5 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 relative overflow-hidden group hover-lift">
              <Layers className="absolute -right-2 -top-2 h-10 w-10 text-slate-100 dark:text-white/[0.02] transition-transform group-hover:scale-110" />
              <strong className="block text-sm text-slate-800 dark:text-slate-100 relative z-10">{ragMetrics.chunks}</strong>
              <span className="relative z-10">Chunks</span>
            </div>
            <div className="rounded-lg bg-white/80 p-2.5 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 relative overflow-hidden group hover-lift">
              <Network className="absolute -right-2 -top-2 h-10 w-10 text-slate-100 dark:text-white/[0.02] transition-transform group-hover:scale-110" />
              <strong className="block text-sm text-slate-800 dark:text-slate-100 relative z-10">{ragMetrics.semanticReady}/{ragMetrics.documents}</strong>
              <span className="relative z-10">{t("Semantic search", "Tìm theo ý nghĩa")}</span>
            </div>
          </div>
          {ragQuality.warnings.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-slate-200/50 dark:border-white/5 pt-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              {ragQuality.warnings.slice(0, 3).map((warning) => (
                <li key={warning} className="flex gap-1.5 items-start">
                  <AlertCircle className="shrink-0 mt-0.5 h-3.5 w-3.5" />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
