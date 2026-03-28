import { useI18n } from "../../lib/i18n";

export default function StatsChips({ stats }) {
  const { t } = useI18n();
  return (
    <div className="stats-chips">
      <span className="stat-chip strong-green" title={t("correct")}>✓ {stats.correctGreen}</span>
      <span className="stat-chip light-green" title="Neutral">~ {stats.neutralGreen}</span>
      <span className="stat-chip red" title={t("redPenalty")}>✗ {stats.red}</span>
      <span className="stat-chip black" title={t("blackPenalty")}>☠ {stats.black}</span>
    </div>
  );
}
