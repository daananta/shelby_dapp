import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound } from "lucide-react";
import { useLanguage } from "@/i18n";
import { normalizeGeminiApiKey } from "@/utils/geminiApiKey";
import { getStoredCloudApiKey } from "@/utils/aiProvider";

export interface ChatApiKeyModalProps {
  show: boolean;
  onClose: () => void;
  cloudApiKey: string;
  onKeyChange: (key: string) => void;
  cloudKeyState: "empty" | "checking" | "ready" | "limited" | "unverified" | "invalid";
  onSave: () => void | Promise<void>;
  onRemove: () => void;
}

export function ChatApiKeyModal({
  show,
  onClose,
  cloudApiKey,
  onKeyChange,
  cloudKeyState,
  onSave,
  onRemove,
}: ChatApiKeyModalProps) {
  const { t } = useLanguage();
  if (!show) return null;

  const normalized = normalizeGeminiApiKey(cloudApiKey);
  const isRetriableState =
    (cloudKeyState === "limited" || cloudKeyState === "unverified") &&
    normalized === getStoredCloudApiKey();

  return (
    <div
      id="gemini-key-panel"
      className="mx-4 mt-3 rounded-xl border border-[#dfe4dc] bg-[#f5f6f2] p-3.5 dark:border-white/[0.06] dark:bg-white/[0.025]"
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="block text-[13px] font-semibold text-slate-800 dark:text-slate-200">
            {t("Connect Gemini", "Kết nối Gemini")}
          </span>
          <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">
            {t(
              "Enter your API key to use Gemini for chat. Qwen remains available without a key.",
              "Nhập API key để dùng Gemini cho chat. Qwen vẫn dùng được mà không cần key.",
            )}
          </span>
        </div>
        <button
          type="button"
          className="text-[11px] font-medium text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          onClick={onClose}
        >
          {t("Close", "Đóng")}
        </button>
      </div>

      <div className="flex gap-1.5">
        <Input
          autoFocus
          type="password"
          name="gemini-api-key"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="h-10 rounded-lg border-[#d8ddd5] bg-[#fdfefa] text-[13px] dark:border-white/[0.08] dark:bg-black/20"
          value={cloudApiKey}
          onChange={(event) => onKeyChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void onSave()}
          placeholder={t("Paste Gemini API key…", "Dán Gemini API key…")}
        />
        <Button
          size="sm"
          className="h-10 shrink-0 rounded-lg bg-[#172019] px-3.5 text-[12px] text-[#c5fb7e] hover:bg-[#263029] dark:bg-lime-300 dark:text-slate-950"
          onClick={() => void onSave()}
          disabled={!cloudApiKey || cloudKeyState === "checking"}
        >
          {cloudKeyState === "checking" ? (
            <>
              <KeyRound className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t("Checking", "Đang kiểm tra")}
            </>
          ) : isRetriableState ? (
            t("Try again", "Thử lại")
          ) : (
            t("Save & check", "Lưu & kiểm tra")
          )}
        </Button>

        {(cloudKeyState === "ready" || cloudKeyState === "limited" || cloudKeyState === "unverified") && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-[11px] text-slate-400 hover:text-red-500"
            onClick={onRemove}
          >
            {t("Remove", "Xoá")}
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between mt-1.5">
        <p
          className={`text-[10.5px] leading-4 ${
            cloudKeyState === "ready"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-slate-400"
          }`}
        >
          {t(
            "This Gemini key stays only in this browser tab. It is never added to RAG or uploaded to Shelby.",
            "Gemini key chỉ được lưu trong phiên tab này. Key không được đưa vào RAG hay tải lên Shelby.",
          )}
        </p>
        {normalized && (
          <span className="shrink-0 pl-3 font-mono text-[10px] font-bold text-slate-500 dark:text-slate-400">
            Key …{normalized.slice(-4)}
          </span>
        )}
      </div>
    </div>
  );
}
