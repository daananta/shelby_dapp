import { useLanguage } from "@/i18n";

export function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div
      className="relative flex h-9 items-center rounded-full border border-slate-200/80 bg-white/70 p-1 shadow-sm dark:border-white/10 dark:bg-white/[0.05]"
      role="group"
      aria-label={t("Choose language", "Chọn ngôn ngữ")}
    >
      <span
        aria-hidden="true"
        className="absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-full bg-slate-900 transition-all duration-300 ease-out dark:bg-white"
        style={{ left: language === "en" ? "4px" : "50%" }}
      />
      <button
        type="button"
        className={`relative z-10 h-7 min-w-8 rounded-full px-2 text-[10px] font-extrabold tracking-wide transition-colors ${
          language === "en"
            ? "text-white dark:text-slate-950"
            : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
        }`}
        onClick={() => setLanguage("en")}
        aria-pressed={language === "en"}
        aria-label="Use English"
      >
        EN
      </button>
      <button
        type="button"
        className={`relative z-10 h-7 min-w-8 rounded-full px-2 text-[10px] font-extrabold tracking-wide transition-colors ${
          language === "vi"
            ? "text-white dark:text-slate-950"
            : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
        }`}
        onClick={() => setLanguage("vi")}
        aria-pressed={language === "vi"}
        aria-label="Dùng tiếng Việt"
      >
        VI
      </button>
    </div>
  );
}
