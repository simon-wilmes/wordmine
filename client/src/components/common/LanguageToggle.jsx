import { useI18n } from "../../lib/i18n";

export default function LanguageToggle({ renderContainer = true }) {
  const { language, setUiLanguage } = useI18n();

  const buttons = (
    <>
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
    </>
  );

  if (!renderContainer) {
    return buttons;
  }

  return (
    <div className="language-toggle">
      {buttons}
    </div>
  );
}
