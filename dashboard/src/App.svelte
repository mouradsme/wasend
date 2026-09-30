<script>
  import { api, hasToken, setToken, whenSignedOut, STATE_LABEL } from "./lib/api.js";
  import { toast, say, fail } from "./lib/toast.svelte.js";
  import Lamp from "./lib/Lamp.svelte";
  import Login from "./views/Login.svelte";
  import SessionView from "./views/SessionView.svelte";
  import KeysView from "./views/KeysView.svelte";
  import AlertsView from "./views/AlertsView.svelte";

  const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

  let signedIn = $state(hasToken() || DEMO);
  let sessions = $state([]); // [{ id, createdAt, state }]
  // "session" | "keys" | "alerts"; the account pages are addressable as #keys and #alerts.
  let view = $state(["keys", "alerts"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "session");
  $effect(() => { history.replaceState(null, "", view === "session" ? location.pathname + location.search : "#" + view); });
  let selected = $state("");
  let newId = $state("");
  let loaded = $state(false);

  whenSignedOut(() => { signedIn = false; });

  async function loadSessions() {
    try {
      const { sessions: rows } = await api("/sessions");
      const previous = new Map(sessions.map((s) => [s.id, s.state]));
      sessions = rows.map((row) => ({ ...row, state: previous.get(row.id) ?? "" }));
      if (!sessions.some((s) => s.id === selected)) selected = sessions[0]?.id ?? "";
      loaded = true;
      await Promise.all(sessions.map(async (s) => {
        try { s.state = (await api("/sessions/" + encodeURIComponent(s.id))).state; } catch { /* keep the last known state */ }
      }));
    } catch (error) { if (signedIn) fail(error); }
  }

  $effect(() => {
    if (!signedIn) return;
    loadSessions();
    const timer = setInterval(loadSessions, 20_000);
    return () => clearInterval(timer);
  });

  async function createSession(event) {
    event.preventDefault();
    try {
      const created = await api("/sessions", { method: "POST", body: { id: newId.trim() } });
      newId = "";
      await loadSessions();
      selected = created.id;
      view = "session";
      say("Session created");
    } catch (error) { fail(error); }
  }

  async function signOut() {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* the token may already be gone */ }
    setToken("");
    signedIn = false;
    sessions = [];
    selected = "";
    loaded = false;
  }

  function open(id) { selected = id; view = "session"; }
  function setState(id, state) { const row = sessions.find((s) => s.id === id); if (row) row.state = state; }
</script>

{#if !signedIn}
  <Login onSignedIn={() => { signedIn = true; }} />
{:else}
  <div class="shell">
    <aside class="rail">
      <div class="brand">WaSend</div>

      <nav aria-label="Sessions">
        <span class="rail-label">Sessions</span>
        {#each sessions as session (session.id)}
          <button class="line" class:active={view === "session" && selected === session.id} onclick={() => open(session.id)} title={STATE_LABEL[session.state] ?? ""}>
            <Lamp state={session.state} />
            <span class="mono">{session.id}</span>
          </button>
        {:else}
          {#if loaded}<p class="rail-empty">No sessions yet. Create one below.</p>{/if}
        {/each}
        <form class="new" onsubmit={createSession}>
          <input class="mono" bind:value={newId} placeholder="new_session_id" aria-label="New session ID" pattern={"[A-Za-z0-9_\\-]{1,64}"} title="1–64 letters, digits, _ or -" required>
          <button class="add" aria-label="Create session">+</button>
        </form>
      </nav>

      <nav aria-label="Account">
        <span class="rail-label">Account</span>
        <button class="line" class:active={view === "keys"} onclick={() => { view = "keys"; }}>API keys</button>
        <button class="line" class:active={view === "alerts"} onclick={() => { view = "alerts"; }}>Alerts</button>
      </nav>

      <button class="line out" onclick={signOut}>Sign out</button>
    </aside>

    <main>
      {#if view === "keys"}
        <KeysView session={selected} />
      {:else if view === "alerts"}
        <AlertsView />
      {:else if selected}
        {#key selected}
          <SessionView id={selected} onState={(state) => setState(selected, state)} onDeleted={loadSessions} />
        {/key}
      {:else if loaded}
        <div class="welcome">
          <span class="label">Start here</span>
          <h1>Create your first session</h1>
          <p class="muted">A session is one WhatsApp account linked to WaSend. Name it in the panel on the left, then scan a QR code to link it.</p>
        </div>
      {/if}
    </main>
  </div>
{/if}

{#if toast.text}
  <div class="toast" class:error={toast.error} role="status">{toast.text}</div>
{/if}

<style>
  .shell { display: grid; grid-template-columns: 250px minmax(0, 1fr); min-height: 100vh; }
  .rail { background: var(--rail); color: var(--rail-text); padding: 22px 14px; display: flex; flex-direction: column; gap: 26px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { font: 800 1.9rem/1 var(--display); letter-spacing: 0.04em; text-transform: uppercase; color: #fff; padding: 0 8px; }
  nav { display: grid; gap: 2px; }
  .rail-label { font: 700 0.74rem/1 var(--display); letter-spacing: 0.16em; text-transform: uppercase; color: #7f90a8; padding: 0 8px 8px; }
  .rail-empty { font-size: 0.87rem; color: #7f90a8; padding: 0 8px 6px; }
  .line { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; border-radius: 7px; padding: 8px; cursor: pointer; }
  .line span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .line:hover { background: var(--rail-line); color: #fff; }
  .line.active { background: #fff; color: var(--ink); }
  .line:focus-visible, .add:focus-visible { outline-color: #fff; }
  .out { margin-top: auto; color: #7f90a8; }
  .new { display: flex; gap: 6px; margin-top: 8px; padding: 0 2px; }
  .new input { background: transparent; border-color: var(--rail-line); color: #fff; padding: 7px 9px; min-width: 0; }
  .new input::placeholder { color: #66778f; }
  .add { flex: none; width: 34px; border-radius: 7px; border: 1px solid var(--rail-line); background: var(--rail-line); color: #fff; font: 600 1.1rem/1 var(--body); cursor: pointer; }
  .add:hover { background: var(--cord); border-color: var(--cord); }

  main { padding: 34px clamp(18px, 4vw, 48px) 60px; min-width: 0; }
  .welcome { max-width: 520px; display: grid; gap: 10px; margin-top: 8vh; }
  .welcome h1 { font: 800 2.6rem/1 var(--display); text-transform: uppercase; letter-spacing: 0.01em; }

  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 11px 16px; border-radius: 8px; max-width: min(560px, calc(100vw - 32px)); box-shadow: 0 8px 28px rgb(14 27 46 / 0.25); z-index: 10; }
  .toast.error { background: var(--lamp-down-ink); }

  @media (max-width: 820px) {
    .shell { grid-template-columns: 1fr; }
    .rail { position: static; height: auto; gap: 18px; }
    .out { margin-top: 0; }
  }
</style>
