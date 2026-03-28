import { Navigate, Route, Routes } from "react-router-dom";
import LanguageToggle from "./components/common/LanguageToggle";
import { I18nProvider } from "./lib/i18n";
import LandingPage from "./pages/LandingPage";
import LobbyPage from "./pages/LobbyPage";
import GamePage from "./pages/GamePage";

export default function App() {
  return (
    <I18nProvider>
      <LanguageToggle />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/lobby/:lobbyId" element={<LobbyPage />} />
        <Route path="/game/:lobbyId" element={<GamePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </I18nProvider>
  );
}
