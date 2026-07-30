import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type AppLanguage = "en" | "vi";

const LANGUAGE_STORAGE_KEY = "shelby-rag-explorer.language";
const DEFAULT_LANGUAGE: AppLanguage = "en";

function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "en" || value === "vi";
}

export function readStoredLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isAppLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

let activeLanguage: AppLanguage = DEFAULT_LANGUAGE;

export function currentLanguage(): AppLanguage {
  return activeLanguage;
}

/** For non-React code paths such as toasts and normalized service errors. */
export function localize(english: string, vietnamese: string): string {
  return activeLanguage === "vi" ? vietnamese : english;
}

interface LanguageContextValue {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: (english: string, vietnamese: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<AppLanguage>(() => {
    const initialLanguage = readStoredLanguage();
    activeLanguage = initialLanguage;
    return initialLanguage;
  });

  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    activeLanguage = nextLanguage;
    setLanguageState(nextLanguage);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    } catch {
      // The selector still works for this tab when browser storage is blocked.
    }
  }, []);

  useEffect(() => {
    activeLanguage = language;
    document.documentElement.lang = language;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) {
      description.content = language === "vi"
        ? "Khám phá blob Shelby và tạo RAG có bằng chứng theo trang ngay trong trình duyệt."
        : "Explore Shelby blobs and build page-cited RAG directly in your browser.";
    }
  }, [language]);

  useEffect(() => {
    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && isAppLanguage(event.newValue)) {
        activeLanguage = event.newValue;
        setLanguageState(event.newValue);
      }
    };
    window.addEventListener("storage", syncAcrossTabs);
    return () => window.removeEventListener("storage", syncAcrossTabs);
  }, []);

  const t = useCallback(
    (english: string, vietnamese: string) => (language === "vi" ? vietnamese : english),
    [language],
  );
  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used inside LanguageProvider.");
  return context;
}
