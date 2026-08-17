import { Check, Cpu, KeyRound, Sparkles } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useLanguage } from "@/i18n";
import type { ChatModelSelection } from "@/utils/hostedModelStorage";

type CloudKeyState = "empty" | "checking" | "ready" | "limited" | "unverified" | "invalid";

interface ChatModelSelectorProps {
  selectedModel: ChatModelSelection;
  cloudKeyState: CloudKeyState;
  geminiPanelOpen: boolean;
  disabled?: boolean;
  onSelect: (model: ChatModelSelection) => void;
}

export function ChatModelSelector({
  selectedModel,
  cloudKeyState,
  geminiPanelOpen,
  disabled = false,
  onSelect,
}: ChatModelSelectorProps) {
  const { t } = useLanguage();
  const geminiHint = cloudKeyState === "ready"
    ? t("API key ready", "API key sẵn sàng")
    : cloudKeyState === "checking"
      ? t("Checking key", "Đang kiểm tra key")
      : cloudKeyState === "limited" || cloudKeyState === "unverified"
        ? t("Check your key", "Kiểm tra lại key")
        : t("Use your API key", "Dùng API key của bạn");

  const options = [
    {
      id: "qwen/qwen3.7-flash" as const,
      title: "Qwen 3.7 Flash",
      hint: t("Default", "Mặc định"),
      icon: Cpu,
      accent: "emerald",
    },
    {
      id: "qwen/qwen3.8-max-free" as const,
      title: "Qwen 3.8 Flash",
      hint: t("New · Free preview", "Mới · Bản thử miễn phí"),
      icon: Sparkles,
      accent: "lime",
    },
    {
      id: "gemini" as const,
      title: "Gemini",
      hint: geminiHint,
      icon: KeyRound,
      accent: "amber",
    },
  ];

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % options.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + options.length) % options.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex === undefined) return;

    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    const nextButton = buttons?.item(nextIndex);
    if (!nextButton) return;
    event.preventDefault();
    nextButton.focus();
    nextButton.click();
  };

  return (
    <div data-testid="chat-model-selector" className="mx-4 mt-3 rounded-xl border border-black/[0.06] bg-white/55 p-2 dark:border-white/[0.07] dark:bg-white/[0.025]">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
          {t("Choose AI", "Chọn AI")}
        </span>
        <span className="text-[10px] text-slate-400">
          {disabled ? t("Finish the current answer first", "Hãy chờ câu trả lời hiện tại") : t("You can change this anytime", "Có thể đổi bất cứ lúc nào")}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1.5 sm:gap-2" role="radiogroup" aria-label={t("Chat model", "Mô hình trò chuyện")}>
        {options.map((option, index) => {
          const Icon = option.icon;
          const selected = selectedModel === option.id;
          const geminiExpanded = option.id === "gemini" && geminiPanelOpen;
          const selectedClasses = option.accent === "amber"
            ? "border-amber-400 bg-amber-50 text-amber-950 shadow-[0_5px_18px_rgba(245,158,11,0.12)] dark:border-amber-300/50 dark:bg-amber-300/10 dark:text-amber-100"
            : "border-emerald-500 bg-emerald-50 text-emerald-950 shadow-[0_5px_18px_rgba(16,185,129,0.11)] dark:border-lime-300/50 dark:bg-lime-300/10 dark:text-lime-100";

          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-expanded={option.id === "gemini" ? geminiPanelOpen : undefined}
              aria-controls={option.id === "gemini" ? "gemini-key-panel" : undefined}
              data-model={option.id}
              data-key-state={option.id === "gemini" ? cloudKeyState : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onSelect(option.id)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              className={`relative flex min-h-[62px] min-w-0 items-center gap-2 rounded-[10px] border px-2 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-55 sm:px-2.5 ${
                selected
                  ? selectedClasses
                  : geminiExpanded
                    ? "border-amber-300 bg-amber-50/65 text-slate-800 dark:border-amber-300/30 dark:bg-amber-300/[0.06] dark:text-slate-100"
                    : "border-slate-200/90 bg-white/80 text-slate-700 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm dark:border-white/[0.08] dark:bg-black/15 dark:text-slate-200 dark:hover:border-white/15"
              }`}
            >
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                option.id === "gemini"
                  ? "bg-gradient-to-br from-amber-100 to-lime-100 text-amber-700 dark:from-amber-300/20 dark:to-lime-300/10 dark:text-amber-200"
                  : "bg-slate-100 text-emerald-700 dark:bg-white/[0.07] dark:text-lime-300"
              }`}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[10.5px] font-extrabold leading-[1.2] sm:text-[11.5px]">
                  {option.title}
                </span>
                <span className="mt-1 block text-[9px] font-medium leading-[1.15] text-slate-500 dark:text-slate-400 sm:text-[10px]">
                  {option.hint}
                </span>
              </span>
              {selected && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-lime-300 dark:text-slate-950">
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
