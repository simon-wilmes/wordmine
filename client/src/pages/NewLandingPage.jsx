import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import spyImg from "../assets/spy/spy-silhouette.svg";
import { createLobby } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { getOrCreateBrowserId, setStoredPlayerId } from "../lib/session";

export default function NewLandingPage() {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const browserId = useMemo(() => getOrCreateBrowserId(), []);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCreateLobby(e) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 25) {
      setError(t("nameLengthError"));
      return;
    }

    setError("");
    setLoading(true);
    try {
      const data = await createLobby(trimmedName, "private", null, browserId, language);
      setStoredPlayerId(data.lobby.id, data.playerId);
      navigate(`/lobby/${data.lobby.id}`);
    } catch (err) {
      setError(err.message || t("createLobbyFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="cluey-landing-root">
      <div className="cluey-grid-cutout" aria-hidden="true" />

      <main className="cluey-landing-main">
        <section className="cluey-start-card card">
          <h1 className="cluey-logo">Cluey.io</h1>
          <p className="cluey-subtitle">{t("newLandingSubtitle")}</p>

          <form className="cluey-start-form" onSubmit={handleCreateLobby}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("enterYourName")}
              minLength={2}
              maxLength={25}
              required
              autoFocus
            />

            <div className="cluey-spy-preview" aria-hidden="true">
              <img src={spyImg} alt="" />
            </div>

            {error && <p className="error cluey-form-error">{error}</p>}

            <button className="cluey-primary-btn" type="submit" disabled={loading}>
              {loading ? t("working") : t("createLobby")}
            </button>

            <button
              className="cluey-secondary-btn"
              type="button"
              onClick={() => navigate("/lobbies")}
            >
              {t("browsePublicLobbies")}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}