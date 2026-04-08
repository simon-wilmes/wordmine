import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { login } from "../lib/api";
import { writeCachedAuthUser } from "../lib/auth";
import { getOrCreateBrowserId } from "../lib/session";

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const requestedNext = String(searchParams.get("next") || "").trim();
  const nextPath = requestedNext.startsWith("/") ? requestedNext : "/";

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const guestCode = getOrCreateBrowserId();
      const data = await login(username.trim().toLowerCase(), password, guestCode);
      writeCachedAuthUser(data.user || null);
      navigate(nextPath, { replace: true });
    } catch (err) {
      setError(err.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="card" style={{ maxWidth: "520px", margin: "0 auto" }}>
        <h1>Log In</h1>
        <p style={{ color: "var(--text-muted)" }}>
          Sign in with your account. Your current browser guest history is linked automatically.
        </p>
        <form onSubmit={handleSubmit}>
          <label>
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              minLength={3}
              maxLength={30}
              required
            />
          </label>
          <label style={{ marginTop: "12px" }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              minLength={8}
              maxLength={200}
              required
            />
          </label>
          {error && <p className="error" style={{ marginTop: "12px" }}>{error}</p>}
          <div className="button-row">
            <button type="button" className="ghost" onClick={() => navigate(-1)} disabled={loading}>Back</button>
            <button type="submit" disabled={loading}>{loading ? "Signing in..." : "Log In"}</button>
          </div>
        </form>
        <p style={{ marginTop: "14px", fontSize: "0.9rem" }}>
          No account yet? <Link to="/signup">Create one</Link>
        </p>
      </section>
    </main>
  );
}
