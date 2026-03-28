import { useI18n } from "../../lib/i18n";

export default function LanguageToggle() {
  const { language, setUiLanguage } = useI18n();

  return (
    <div className="language-toggle">
      <button
        className={`lang-btn${language === "en" ? " active" : ""}`}
        onClick={() => setUiLanguage("en")}
      >
        EN
      </button>
      <button
        className={`lang-btn${language === "de" ? " active" : ""}`}
        onClick={() => setUiLanguage("de")}
      >
        DE
      </button>
    </div>
  );
}
