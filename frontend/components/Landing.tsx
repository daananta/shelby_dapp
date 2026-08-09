import {
  ArrowRight,
  Binary,
  BookOpenCheck,
  Braces,
  Check,
  Database,
  FileSearch,
  Fingerprint,
  Gauge,
  Quote,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useLanguage } from "@/i18n";
import { NetworkSelector } from "@/components/NetworkSelector";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";

interface LandingProps {
  onConnect: () => void;
  onDemo: () => void;
}

/** Wallet-free product story; the heavy wallet runtime stays lazy-loaded. */
export function Landing({ onConnect, onDemo }: LandingProps) {
  const { t } = useLanguage();
  const { network } = useShelbyNetwork();
  const pipeline = [
    { icon: Binary, label: t("Read the real content", "Đọc đúng nội dung"), meta: t("Independent of file extension", "Không phụ thuộc đuôi tệp"), state: "done" },
    { icon: Braces, label: t("Build a searchable index", "Tạo kho tra cứu"), meta: t("Source-linked passages", "Các đoạn kèm nguồn"), state: "done" },
    { icon: Fingerprint, label: t("Fetch only what matters", "Chỉ lấy phần cần"), meta: t("Never download the full RAG", "Không tải cả kho RAG"), state: "active" },
  ];

  return (
    <main className="launch-page min-h-screen overflow-x-hidden text-slate-950 dark:text-white">
      <div className="launch-grid" aria-hidden="true" />
      <header className="relative z-20 border-b border-slate-900/[0.07] bg-[#f6f7f2]/80 backdrop-blur-xl dark:border-white/[0.08] dark:bg-[#080b0d]/80">
        <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between px-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-[#b7f56b] shadow-[0_8px_24px_rgba(15,23,42,0.18)] dark:bg-[#b7f56b] dark:text-slate-950 sm:h-9 sm:w-9">
              <Database className="h-[18px] w-[18px]" strokeWidth={2.2} />
            </div>
            <div className="min-w-0">
              <h1 className="whitespace-nowrap text-[13px] font-extrabold tracking-[-0.02em] sm:text-sm">
                <span className="sm:hidden">Shelby RAG</span>
                <span className="hidden sm:inline">Shelby RAG Explorer</span>
              </h1>
              <p className="hidden text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400 sm:block">{t("Verifiable knowledge workspace", "Kho tri thức kiểm chứng được")}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <div className="hidden sm:block"><NetworkSelector /></div>
            <LanguageToggle />
            <ThemeToggle />
            <Button onClick={onConnect} size="sm" className="hidden rounded-full bg-slate-950 px-4 text-xs text-white hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200 sm:inline-flex">
              {t("Open workspace", "Mở workspace")} <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <section className="relative z-10 mx-auto grid w-full max-w-[1440px] grid-cols-1 gap-10 px-5 pb-14 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-16 lg:pb-20 lg:pt-24">
        <div className="min-w-0 max-w-2xl">
          <div className="mb-4 sm:hidden"><NetworkSelector compact /></div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-slate-900/10 bg-white/60 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.13em] text-slate-600 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300">
            <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-[#b7f56b]" />
            {t("RAG for Shelby data", "RAG cho dữ liệu Shelby")}
          </div>
          <h2 className="max-w-full text-[clamp(2.35rem,11.5vw,5.75rem)] font-black leading-[0.94] tracking-[-0.055em] text-slate-950 dark:text-white sm:leading-[0.92] sm:tracking-[-0.065em]">
            {t("Ask your Shelby data.", "Hỏi dữ liệu Shelby.")}
            <span className="mt-2 block text-slate-400 dark:text-slate-500">{t("Get evidence back.", "Nhận lại bằng chứng.")}</span>
          </h2>
          <p className="mt-7 max-w-xl text-base leading-7 text-slate-600 dark:text-slate-300 sm:text-lg sm:leading-8">
            {t(
              "Turn blobs into a searchable knowledge base, fetch only the relevant ranges from Shelby, and keep a trail you can verify.",
              "Biến blob thành kho tri thức có thể tra cứu trực tiếp từ Shelby, chỉ tải phần liên quan và trả lời kèm dấu vết để kiểm tra.",
            )}
          </p>
          {network === "shelbynet" && (
            <p className="mt-3 text-xs font-semibold text-amber-700 dark:text-amber-300">
              {t("ShelbyNet is a developer network; its data may be reset.", "ShelbyNet là mạng dành cho developer; dữ liệu có thể được reset.")}
            </p>
          )}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button onClick={onConnect} className="h-14 rounded-2xl bg-gradient-to-br from-lime-400 to-emerald-500 px-8 text-[15px] font-extrabold text-slate-950 shadow-[0_14px_34px_rgba(132,204,22,0.25)] hover:shadow-[0_14px_34px_rgba(132,204,22,0.4)] transition-all hover:-translate-y-0.5">
              <Wallet className="mr-2 h-5 w-5" /> {t("Connect wallet to start", "Kết nối ví để bắt đầu")}
            </Button>
            <Button onClick={onDemo} variant="outline" className="h-14 rounded-2xl border-slate-900/15 bg-white/50 px-8 text-[15px] font-bold text-slate-800 backdrop-blur-sm hover:bg-white dark:border-white/15 dark:bg-white/[0.04] dark:text-white dark:hover:bg-white/[0.08] transition-all hover:-translate-y-0.5">
              <BookOpenCheck className="mr-2 h-5 w-5" /> {t("Try the wallet-free demo", "Xem mô phỏng không cần ví")}
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-600" /> {t("Use your existing blobs", "Dùng ngay blob đã có")}</span>
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-600" /> {t("Fetch only relevant RAG ranges", "Chỉ tải phần RAG liên quan")}</span>
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-600" /> {t("Knowledge isolated per wallet", "Kho tri thức tách theo ví")}</span>
          </div>
        </div>

        <div className="relative mx-auto min-w-0 w-full max-w-[610px]">
          <div className="absolute -inset-8 -z-10 rounded-[3rem] bg-[#b7f56b]/15 blur-3xl dark:bg-[#b7f56b]/10" />
          <div className="overflow-hidden rounded-[28px] border border-slate-900/10 bg-[#0d1215] p-2 shadow-[0_36px_100px_rgba(15,23,42,0.24)] dark:border-white/10">
            <div className="rounded-[22px] border border-white/[0.08] bg-[#11181c]">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#b7f56b] shadow-[0_0_14px_rgba(183,245,107,.65)]" />
                  <span className="truncate text-xs font-bold text-white">{t("From blob to verifiable answer", "Từ blob đến câu trả lời kiểm chứng được")}</span>
                </div>
                <span className="font-mono text-[10px] text-slate-500">0x71…c92</span>
              </div>
              <div className="grid grid-cols-1 gap-3 p-5">
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.07] text-[#b7f56b]"><FileSearch className="h-5 w-5" /></div>
                      <div className="min-w-0"><p className="truncate text-sm font-bold text-white">shelby://research/alpha-07</p><p className="mt-0.5 text-[11px] text-slate-500">12.8 MB · {t("Shelby data blob", "blob dữ liệu Shelby")}</p></div>
                    </div>
                    <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold text-emerald-300">{t("PUBLIC", "CÔNG KHAI")}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {pipeline.map(({ icon: Icon, label, meta, state }) => (
                      <div key={label} className={`rounded-xl border p-3 ${state === "active" ? "border-[#b7f56b]/30 bg-[#b7f56b]/[0.08]" : "border-white/[0.07] bg-black/10"}`}>
                        <Icon className={`mb-3 h-4 w-4 ${state === "active" ? "text-[#b7f56b]" : "text-slate-400"}`} />
                        <p className="text-[11px] font-bold text-white">{label}</p><p className="mt-1 text-[10px] leading-4 text-slate-500">{meta}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="min-w-0 rounded-2xl border border-white/[0.08] bg-[#f3f5ee] p-5 text-slate-950">
                  <div className="flex items-start gap-3"><Quote className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" /><div className="min-w-0 flex-1"><p className="break-words text-sm font-bold leading-6">{t("“How is the consensus mechanism described?”", "“Cơ chế đồng thuận được mô tả như thế nào?”")}</p><p className="mt-2 break-words text-xs leading-5 text-slate-600">{t("The system prioritizes data availability through…", "Hệ thống ưu tiên tính sẵn sàng dữ liệu qua…")}</p></div></div>
                  <div className="mt-4 flex items-center justify-between border-t border-slate-900/10 pt-3"><span className="text-[10px] font-bold text-emerald-700">alpha-07 · {t("page 14", "trang 14")}</span><span className="text-[10px] font-semibold text-slate-500">{t("hybrid", "kết hợp")} · 92%</span></div>
                </div>
              </div>
            </div>
          </div>
          <div className="absolute -bottom-5 -left-4 hidden items-center gap-3 rounded-2xl border border-slate-900/10 bg-white px-4 py-3 shadow-xl dark:border-white/10 dark:bg-slate-900 sm:flex">
            <Gauge className="h-5 w-5 text-emerald-600" /><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Shelby Hot RAG</p><p className="text-xs font-extrabold">{t("Never download the full RAG", "Không tải toàn bộ bản RAG")}</p></div>
          </div>
        </div>
      </section>

      <section className="relative z-10 border-y border-slate-900/[0.07] bg-white/45 dark:border-white/[0.07] dark:bg-white/[0.02]">
        <div className="mx-auto grid w-full max-w-[1440px] divide-y divide-slate-900/[0.07] px-5 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-8 dark:divide-white/[0.07]">
          {[
            { icon: Binary, value: t("Read the real content", "Đọc nội dung thật"), label: t("Independent of name or file extension", "Không phụ thuộc tên hoặc đuôi tệp") },
            { icon: ShieldCheck, value: t("Safe by default", "An toàn mặc định"), label: t("Unreadable until access is verified", "Không đọc dữ liệu khi chưa xác minh được quyền") },
            { icon: Fingerprint, value: t("Wallet-scoped", "Theo từng ví"), label: t("Knowledge and history remain isolated", "Kho tri thức và lịch sử được tách biệt") },
          ].map(({ icon: Icon, value, label }) => (
            <div key={value} className="flex items-center gap-4 py-6 sm:px-7 first:sm:pl-0 last:sm:pr-0"><Icon className="h-5 w-5 shrink-0 text-emerald-700 dark:text-[#b7f56b]" /><div><p className="text-sm font-extrabold">{value}</p><p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{label}</p></div></div>
          ))}
        </div>
      </section>
    </main>
  );
}
