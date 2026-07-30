import { useEffect, useState } from "react";
import { ArrowLeft, BookOpenCheck, Check, FileCheck2, FileSearch, Loader2, Quote, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLanguage, type AppLanguage } from "@/i18n";
import { getRagSources, lookupExactQuote, replaceDocument, setActiveRagOwner } from "@/utils/ragOrama";
import type { DocumentReplacement, RetrievalResult } from "@/utils/ragTypes";

const DEMO_OWNER = "__shelby_rag_demo__";
const DEMO_SOURCE = "shelby-rag-evidence-demo.pdf";
const DEMO_COPY = {
  en: {
    defaultQuote: "Every answer based on a document must include its file name, page number, and supporting excerpt.",
    policyQuote: "The app only adds public files and unlocked time-locked files to the searchable knowledge base.",
    displayName: "Shelby sample document",
    alias: "evidence demo",
    pages: [
      "Shelby RAG Explorer — sample data. The app only adds public files and unlocked time-locked files to the searchable knowledge base. Files without access permission are skipped.",
      "Each page is stored with its source location. Every answer based on a document must include its file name, page number, and supporting excerpt.",
      "An Answer Receipt records the source, page, and verification status when it is created. It does not claim that every AI inference is correct.",
    ],
    preparing: "Preparing sample data…",
    ready: "Ready. No wallet, API key, or transaction required.",
    unavailable: "This browser cannot open the demo.",
    found: "Found a related passage and its source location.",
    notFound: "This sentence was not found in the sample data.",
  },
  vi: {
    defaultQuote: "Mọi câu trả lời về tài liệu phải kèm tên tài liệu, số trang và đoạn trích làm căn cứ.",
    policyQuote: "Ứng dụng chỉ đưa tệp công khai và tệp khóa thời gian đã mở vào kho tra cứu.",
    displayName: "Tài liệu minh họa Shelby",
    alias: "demo bằng chứng",
    pages: [
      "Shelby RAG Explorer — dữ liệu minh họa. Ứng dụng chỉ đưa tệp công khai và tệp khóa thời gian đã mở vào kho tra cứu. Tệp chưa được phép truy cập sẽ bị bỏ qua.",
      "Mỗi trang được lưu cùng vị trí nguồn. Mọi câu trả lời về tài liệu phải kèm tên tài liệu, số trang và đoạn trích làm căn cứ.",
      "Phiếu kiểm chứng ghi nguồn, trang và mức đối chiếu tại thời điểm tạo. Phiếu không khẳng định mọi suy luận của AI đều đúng.",
    ],
    preparing: "Đang chuẩn bị dữ liệu minh họa…",
    ready: "Sẵn sàng. Không cần ví, API key hoặc giao dịch.",
    unavailable: "Không thể mở mô phỏng trên trình duyệt này.",
    found: "Đã tìm thấy đoạn liên quan và vị trí nguồn.",
    notFound: "Không tìm thấy câu này trong dữ liệu minh họa.",
  },
} as const satisfies Record<AppLanguage, {
  defaultQuote: string;
  policyQuote: string;
  displayName: string;
  alias: string;
  pages: readonly string[];
  preparing: string;
  ready: string;
  unavailable: string;
  found: string;
  notFound: string;
}>;

function normalize(text: string) {
  return text.normalize("NFC").toLocaleLowerCase("vi-VN").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

function demoDocument(language: AppLanguage): DocumentReplacement {
  const copy = DEMO_COPY[language];
  const documentId = `${DEMO_OWNER}:${DEMO_SOURCE}`;
  const pageText = copy.pages;
  const pages = pageText.map((rawText, index) => ({
    id: `${documentId}:page:${index + 1}`,
    owner: DEMO_OWNER,
    documentId,
    source: DEMO_SOURCE,
    displayName: copy.displayName,
    pageNumber: index + 1,
    totalPages: pageText.length,
    rawText,
    normalizedText: normalize(rawText),
    extractionMethod: "text_layer" as const,
  }));
  return {
    manifest: {
      id: documentId,
      owner: DEMO_OWNER,
      source: DEMO_SOURCE,
      displayName: copy.displayName,
      revision: `demo-v4-${language}`,
      mimeType: "application/pdf",
      type: "text",
      title: { value: copy.displayName, confidence: 1, provenance: "user", userLocked: true },
      aliases: [copy.alias],
      authors: [],
      pageCount: pages.length,
      chunkCount: pages.length,
      ocrCoverage: 0,
      textCoverage: 1,
      embeddingStatus: "unavailable",
      status: "indexed",
      indexedAt: 1,
    },
    pages,
    chunks: pages.map((page, index) => ({
      id: `${documentId}:chunk:${index}`,
      owner: DEMO_OWNER,
      documentId,
      source: DEMO_SOURCE,
      displayName: copy.displayName,
      type: "text" as const,
      text: page.rawText,
      normalizedText: page.normalizedText,
      pageNumber: page.pageNumber,
      totalPages: page.totalPages,
    })),
    stories: [],
  };
}

interface DemoWorkspaceProps {
  onConnect: () => void;
  onExit: () => void;
}

/** Wallet-free, deterministic product walkthrough. It never pretends to read live Shelby data. */
export default function DemoWorkspace({ onConnect, onExit }: DemoWorkspaceProps) {
  const { language, t } = useLanguage();
  const copy = DEMO_COPY[language];
  const [ready, setReady] = useState(false);
  const [quote, setQuote] = useState<string>(copy.defaultQuote);
  const [checkedQuote, setCheckedQuote] = useState("");
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const [message, setMessage] = useState<string>(copy.preparing);

  useEffect(() => {
    let current = true;
    setReady(false);
    setResult(null);
    setCheckedQuote("");
    setQuote(copy.defaultQuote);
    setMessage(copy.preparing);
    void (async () => {
      await setActiveRagOwner(DEMO_OWNER);
      const existing = getRagSources().find((source) => source.source === DEMO_SOURCE);
      if (existing?.revision !== `demo-v4-${language}`) await replaceDocument(demoDocument(language));
      if (!current) return;
      setReady(true);
      setMessage(copy.ready);
    })().catch(() => current && setMessage(copy.unavailable));
    return () => { current = false; };
  }, [copy, language]);

  const findQuote = async (value = quote) => {
    const candidate = value.trim();
    if (!ready || !candidate) return;
    setCheckedQuote(candidate);
    const found = await lookupExactQuote(candidate);
    setResult(found);
    setMessage(found ? copy.found : copy.notFound);
  };

  const chooseExample = (value: string) => {
    setQuote(value);
    setResult(null);
    setCheckedQuote("");
    void findQuote(value);
  };

  const steps = [
    { label: t("Search the knowledge base", "Tìm trong kho"), ready },
    { label: t("Show the source", "Chỉ ra nguồn"), ready: Boolean(result) },
    { label: t("Create a receipt", "Tạo phiếu"), ready: Boolean(result) },
  ];

  return (
    <main className="app-canvas min-h-screen text-slate-900 dark:text-slate-100">
      <header className="border-b border-slate-200/80 bg-white/70 backdrop-blur-xl dark:border-white/[0.06] dark:bg-slate-950/35">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#172019] text-[#c5fb7e] dark:bg-lime-300 dark:text-slate-950"><BookOpenCheck className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-extrabold">Shelby RAG Explorer</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("Wallet-free walkthrough · sample data", "Mô phỏng không cần ví · dữ liệu minh họa")}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onExit} aria-label={t("Back to home", "Về trang đầu")}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              <span className="hidden sm:inline">{t("Home", "Trang đầu")}</span>
            </Button>
            <Button size="sm" onClick={onConnect}>
              <Wallet className="mr-1 h-4 w-4" />
              {t("Connect wallet", "Kết nối ví")}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 lg:grid-cols-[0.72fr_1.28fr] lg:py-10">
        <Card className="glass-panel h-fit overflow-hidden">
          <CardHeader>
            <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-emerald-700 dark:text-lime-300">
              {t("See the value in 20 seconds", "Hiểu giá trị trong 20 giây")}
            </p>
            <CardTitle className="text-2xl font-black tracking-[-0.035em]">
              {t("From question to evidence", "Từ câu hỏi đến bằng chứng")}
            </CardTitle>
            <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
              {t(
                "AI answers naturally. When it uses your data, the app keeps the passage and location so you can verify the answer.",
                "AI có thể trả lời tự nhiên; khi dùng tài liệu, ứng dụng giữ lại đoạn trích và vị trí để bạn tự kiểm tra.",
              )}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="space-y-2" aria-label={t("Demo flow", "Luồng mô phỏng")}>
              {steps.map((step, index) => (
                <li key={step.label} className={`flex items-center gap-3 rounded-xl border p-3 text-sm ${step.ready ? "border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:border-emerald-300/15 dark:bg-emerald-300/[0.06] dark:text-emerald-100" : "border-slate-200 bg-white/60 text-slate-400 dark:border-white/[0.07] dark:bg-white/[0.025]"}`}>
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black ${step.ready ? "bg-emerald-600 text-white" : "bg-slate-100 dark:bg-white/10"}`}>{step.ready ? <Check className="h-4 w-4 stroke-[3]" /> : index + 1}</span>
                  <span className="font-bold">{step.label}</span>
                </li>
              ))}
            </ol>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-xl bg-slate-100 p-3 dark:bg-white/[0.06]"><strong className="block text-lg">1</strong>{t("Document", "Tài liệu")}</div>
              <div className="rounded-xl bg-slate-100 p-3 dark:bg-white/[0.06]"><strong className="block text-lg">3</strong>{t("Pages", "Trang")}</div>
              <div className="rounded-xl bg-slate-100 p-3 dark:bg-white/[0.06]"><strong className="block text-lg">0</strong>{t("Transactions", "Giao dịch")}</div>
            </div>
            <p className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-xs leading-5 text-amber-900 dark:border-amber-300/15 dark:bg-amber-300/[0.06] dark:text-amber-100">
              <ShieldCheck className="mr-1.5 inline h-4 w-4" />
              {t(
                "This walkthrough runs locally. After you connect a wallet, the 90-second demo uses real Shelby blobs and status.",
                "Đây là mô phỏng cục bộ. Sau khi kết nối ví, Demo 90 giây sẽ dùng blob và trạng thái Shelby thật.",
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="section-surface relative min-h-[34rem] overflow-hidden">
          <CardHeader className="border-b border-slate-100 dark:border-white/[0.06]">
            <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-emerald-700 dark:text-lime-300">
              {t("Try it now", "Thử ngay")}
            </p>
            <CardTitle className="flex items-center gap-2 text-xl">
              <FileSearch className="h-5 w-5" />
              {t("Find a sentence and inspect its source", "Tìm một câu và xem nguồn")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={quote}
                onChange={(event) => {
                  setQuote(event.target.value);
                  setResult(null);
                  setCheckedQuote("");
                }}
                onKeyDown={(event) => event.key === "Enter" && void findQuote()}
                disabled={!ready}
                aria-label={t("Sentence to find in the walkthrough", "Câu cần tìm trong mô phỏng")}
                className="h-11"
              />
              <Button className="h-11 shrink-0" onClick={() => void findQuote()} disabled={!ready || !quote.trim()}>
                {ready ? <FileSearch className="mr-2 h-4 w-4" /> : <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Find source", "Tìm nguồn")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!ready} onClick={() => chooseExample(copy.defaultQuote)}>
                <Quote className="mr-1.5 h-3.5 w-3.5" />
                {t("Citation rule", "Quy tắc dẫn nguồn")}
              </Button>
              <Button size="sm" variant="outline" disabled={!ready} onClick={() => chooseExample(copy.policyQuote)}>
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                {t("Access rule", "Quy tắc truy cập")}
              </Button>
            </div>

            {result ? (
              <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
                <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-300/15 dark:bg-emerald-300/[0.06]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                        {t("Source found", "Nguồn tìm thấy")}
                      </p>
                      <h2 className="mt-1 text-sm font-black">
                        {result.displayName} · {t("page", "trang")} {result.pageNumber}/{result.totalPages}
                      </h2>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-emerald-700 dark:bg-black/20 dark:text-emerald-200">
                      {result.method === "exact" ? t("Exact match", "Khớp nguyên văn") : t("Close match", "Khớp gần đúng")}
                    </span>
                  </div>
                  <p className="mt-3 border-l-2 border-emerald-400 pl-3 text-sm leading-6 text-slate-700 dark:text-slate-200">“{result.excerpt}”</p>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_35px_rgba(15,23,42,.06)] dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 text-sm font-black">
                        <FileCheck2 className="h-4 w-4 text-emerald-600" />
                        {t("Sample Answer Receipt", "Phiếu kiểm chứng mẫu")}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {t("Sample data · not matched against a Shelby blob", "Dữ liệu minh họa · chưa đối chiếu blob Shelby")}
                      </p>
                    </div>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-extrabold text-amber-800 dark:bg-amber-300/10 dark:text-amber-200">
                      {t("DEMO ONLY", "CHỈ MÔ PHỎNG")}
                    </span>
                  </div>
                  <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-700 dark:bg-black/20 dark:text-slate-200">
                    {t(
                      `This sentence appears in the sample document on page ${result.pageNumber} [S1].`,
                      `Câu này xuất hiện trong tài liệu minh họa ở trang ${result.pageNumber} [S1].`,
                    )}
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {[
                      t("Includes excerpt", "Có đoạn trích"),
                      t("Includes page", "Có số trang"),
                      t("Includes source link", "Có nguồn liên kết"),
                    ].map((label) => (
                      <span key={label} className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-2 text-[11px] font-bold text-emerald-800 dark:bg-emerald-300/[0.06] dark:text-emerald-200">
                        <Check className="h-3.5 w-3.5" />
                        {label}
                      </span>
                    ))}
                  </div>
                  <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {t(
                      "In a real workspace, the Answer Receipt also reloads the source when it is created to compare the file fingerprint on Shelby. It does not claim that every AI inference is correct.",
                      "Trong workspace thật, Phiếu kiểm chứng còn tải lại nguồn tại thời điểm tạo để đối chiếu mã tệp trên Shelby. Phiếu không khẳng định mọi suy luận của AI đều đúng.",
                    )}
                  </p>
                </section>
              </div>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 p-8 text-center dark:border-white/15">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-white/[0.06]"><Quote className="h-5 w-5" /></div>
                <p className="mt-3 text-sm font-bold text-slate-700 dark:text-slate-200">{message}</p>
                {checkedQuote && <p className="mt-2 max-w-md text-xs leading-5 text-slate-400">“{checkedQuote}”</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
