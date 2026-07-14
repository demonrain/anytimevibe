import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { detectLocale, LOCALE_STORAGE_KEY, messages, type Locale, type MessageKey } from "./locales";

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale: (next) => {
      setLocaleState(next);
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    },
    t: (key) => messages[locale][key] ?? messages.en[key] ?? key
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
