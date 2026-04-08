import { useState } from "react";
import LanguageToggle from "./LanguageToggle";
import RulesModal from "./RulesModal";
import { useI18n } from "../../lib/i18n";

export default function TopRightControls() {
  const { t } = useI18n();
  const [isRulesOpen, setIsRulesOpen] = useState(false);

  return (
    <>
      <div className="language-toggle" aria-label={t("uiLanguage")}>
        <button
          type="button"
          className="lang-btn rules-btn"
          onClick={() => setIsRulesOpen(true)}
        >
          {t("rulesButton")}
        </button>
        <LanguageToggle renderContainer={false} />
      </div>
      <RulesModal isOpen={isRulesOpen} onClose={() => setIsRulesOpen(false)} />
    </>
  );
}
