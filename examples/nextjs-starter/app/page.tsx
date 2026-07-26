"use client";

import { useState } from "react";
import { authed, signIn, signUp, type PlutoSession } from "../lib/pluto";

type Note = { id: string; user_id: string; body: string; created_at?: string };

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState<PlutoSession | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function withErr(fn: () => Promise<void>) {
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  const doSignUp = () => withErr(async () => setSession(await signUp(email, password)));
  const doSignIn = () => withErr(async () => setSession(await signIn(email, password)));
  const loadNotes = () =>
    withErr(async () => setNotes((await (await authed(session).from<Note>("notes")).list()) ?? []));
  const addNote = () =>
    withErr(async () => {
      await (await authed(session).from<Note>("notes")).insert({ body });
      setBody("");
      await loadNotes();
    });

  return (
    <main style={{ maxWidth: 640, margin: "0 auto" }}>
      <h1>Pluto BaaS — E2E starter</h1>

      <section data-testid="auth-section" style={{ margin: "16px 0", padding: 16, border: "1px solid #ddd" }}>
        <h2>1. Auth</h2>
        <input
          data-testid="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />{" "}
        <input
          data-testid="password"
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div style={{ marginTop: 8 }}>
          <button data-testid="signup" onClick={doSignUp}>
            Sign up
          </button>{" "}
          <button data-testid="signin" onClick={doSignIn}>
            Sign in
          </button>
        </div>
        <div data-testid="session">
          {session ? `Signed in as ${session.user.email} (${session.user.id})` : "signed out"}
        </div>
      </section>

      <section style={{ margin: "16px 0", padding: 16, border: "1px solid #ddd" }}>
        <h2>2. RLS — private notes</h2>
        <input
          data-testid="note-body"
          placeholder="note body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />{" "}
        <button data-testid="add-note" onClick={addNote} disabled={!session}>
          Add
        </button>{" "}
        <button data-testid="load-notes" onClick={loadNotes}>
          Reload
        </button>
        <ul data-testid="notes">
          {notes.map((n) => (
            <li key={n.id}>{n.body}</li>
          ))}
        </ul>
      </section>

      <section style={{ margin: "16px 0", padding: 16, border: "1px solid #ddd" }}>
        <h2>3. Webhooks</h2>
        <p>
          Configure a Pluto webhook to <code>POST /api/webhooks/pluto</code> on this app. The
          handler verifies <code>X-Pluto-Signature</code> using <code>PLUTO_WEBHOOK_SECRET</code>.
        </p>
      </section>

      {err && (
        <pre data-testid="err" style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          {err}
        </pre>
      )}
    </main>
  );
}
