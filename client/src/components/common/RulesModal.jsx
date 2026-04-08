import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../lib/i18n";

const TAB_IDS = ["quick", "core", "advanced"];

function RulesLegendChip({ className, label, text }) {
  return (
    <div className={`rules-legend-chip ${className}`}>
      <h4>{label}</h4>
      <p>{text}</p>
    </div>
  );
}

function RulesList({ items }) {
  return (
    <ul className="rules-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function RulesModal({ isOpen, onClose }) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState("quick");

  useEffect(() => {
    if (!isOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setActiveTab("quick");
    }
  }, [isOpen]);

  const quickItems = useMemo(() => [
    t("rulesQuickBullet1"),
    t("rulesQuickBullet2"),
    t("rulesQuickBullet3"),
    t("rulesQuickBullet4"),
    t("rulesQuickBullet5")
  ], [t]);

  const coreItems = useMemo(() => [
    t("rulesCoreFlowBullet1"),
    t("rulesCoreFlowBullet2"),
    t("rulesCoreFlowBullet3"),
    t("rulesCoreFlowBullet4"),
    t("rulesCoreFlowBullet5"),
    t("rulesCoreFlowBullet6")
  ], [t]);

  const advancedItems = useMemo(() => [
    t("rulesAdvancedBullet1"),
    t("rulesAdvancedBullet2"),
    t("rulesAdvancedBullet3"),
    t("rulesAdvancedBullet4"),
    t("rulesAdvancedBullet5")
  ], [t]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop rules-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rules-modal-title"
      onClick={onClose}
    >
      <div className="rules-modal" onClick={(e) => e.stopPropagation()}>
        <header className="rules-modal-header">
          <div>
            <h2 id="rules-modal-title">{t("rulesModalTitle")}</h2>
            <p>{t("rulesModalSubtitle")}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            {t("close")}
          </button>
        </header>

        <nav className="rules-tabs" aria-label={t("rulesTabsLabel")}>
          {TAB_IDS.map((tabId) => (
            <button
              key={tabId}
              type="button"
              className={`rules-tab-btn${activeTab === tabId ? " active" : ""}`}
              onClick={() => setActiveTab(tabId)}
            >
              {t(`rulesTab${tabId[0].toUpperCase()}${tabId.slice(1)}`)}
            </button>
          ))}
        </nav>

        <div className="rules-modal-scroll">
          {activeTab === "quick" && (
            <section className="rules-section">
              <h3>{t("rulesQuickTitle")}</h3>
              <RulesList items={quickItems} />

              <div className="rules-legend-grid">
                <RulesLegendChip className="good" label={t("rulesLegendGoodTitle")} text={t("rulesLegendGoodText")} />
                <RulesLegendChip className="neutral" label={t("rulesLegendNeutralTitle")} text={t("rulesLegendNeutralText")} />
                <RulesLegendChip className="bad" label={t("rulesLegendBadTitle")} text={t("rulesLegendBadText")} />
                <RulesLegendChip className="critical" label={t("rulesLegendCriticalTitle")} text={t("rulesLegendCriticalText")} />
              </div>

              <div className="rules-example card">
                <h4>{t("rulesExampleTitle")}</h4>
                <p>{t("rulesExampleText")}</p>
              </div>
            </section>
          )}

          {activeTab === "core" && (
            <section className="rules-section">
              <h3>{t("rulesCoreTitle")}</h3>
              <p>{t("rulesCoreIntro")}</p>
              <RulesList items={coreItems} />
              <p>{t("rulesCoreOutro")}</p>
            </section>
          )}

          {activeTab === "advanced" && (
            <section className="rules-section">
              <h3>{t("rulesAdvancedTitle")}</h3>
              <p>{t("rulesAdvancedIntro")}</p>
              <RulesList items={advancedItems} />

              <div className="rules-example card">
                <h4>{t("rulesScoringExampleTitle")}</h4>
                <p>{t("rulesScoringExampleText")}</p>
              </div>

              <div className="rules-image-ideas card">
                <h4>{t("rulesImagesTitle")}</h4>
                <ul className="rules-list">
                  <li>{t("rulesImagesBullet1")}</li>
                  <li>{t("rulesImagesBullet2")}</li>
                  <li>{t("rulesImagesBullet3")}</li>
                  <li>{t("rulesImagesBullet4")}</li>
                </ul>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
