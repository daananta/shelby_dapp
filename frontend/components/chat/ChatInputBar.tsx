import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Square } from "lucide-react";
import { useLanguage } from "@/i18n";

export interface ChatInputBarProps {
  query: string;
  onQueryChange: (val: string) => void;
  onSend: () => void;
  onAbort: () => void;
  loading: boolean;
  placeholder: string;
}

export function ChatInputBar({
  query,
  onQueryChange,
  onSend,
  onAbort,
  loading,
  placeholder,
}: ChatInputBarProps) {
  const { t } = useLanguage();

  return (
    <div className="flex gap-3 bg-transparent p-4 sm:px-5 sm:pb-5">
      <Input
        aria-label={t("Enter a question", "Nhập câu hỏi")}
        className="h-14 rounded-2xl border-black/5 bg-white/60 px-5 text-sm shadow-inner backdrop-blur-md focus-visible:ring-lime-500 dark:border-white/5 dark:bg-black/40 dark:text-slate-100 transition-all focus:bg-white dark:focus:bg-black/60"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={placeholder}
        onKeyDown={(event) => event.key === "Enter" && !loading && void onSend()}
      />
      <Button
        className="h-14 w-14 shrink-0 rounded-2xl bg-gradient-to-br from-lime-400 to-emerald-500 p-0 text-slate-950 shadow-md hover:-translate-y-0.5 hover:shadow-lg transition-all disabled:opacity-50"
        onClick={() => (loading ? onAbort() : void onSend())}
        disabled={!loading && !query.trim()}
        aria-label={loading ? t("Stop response", "Dừng phản hồi") : t("Send question", "Gửi câu hỏi")}
      >
        {loading ? <Square className="w-4 h-4" /> : <Send className="w-4 h-4" />}
      </Button>
    </div>
  );
}
