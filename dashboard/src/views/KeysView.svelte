<script>
  import { api } from "../lib/api.js";
  import { say, fail } from "../lib/toast.svelte.js";

  let { session = "" } = $props();
  let keys = $state([]);
  let name = $state("");
  let fresh = $state("");

  let example = $derived(`curl -X POST ${location.origin}/v1/sessions/${session || "SESSION_ID"}/messages \\
  -H "Authorization: Bearer ${fresh || "YOUR_API_KEY"}" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"+15551234567","text":"Your code is 123456","kind":"otp"}'`);

  async function load() { try { keys = (await api("/api-keys")).apiKeys; } catch (error) { fail(error); } }
  $effect(() => { load(); });

  async function create(event) {
    event.preventDefault();
    try {
      const created = await api("/api-keys", { method: "POST", body: { name } });
      fresh = created.key;
      name = "";
      say("API key created");
      load();
    } catch (error) { fail(error); }
  }
  async function revoke(key) {
    if (!confirm(`Revoke "${key.name}"? Applications using it stop working immediately.`)) return;
    try { await api("/api-keys/" + encodeURIComponent(key.id), { method: "DELETE" }); say("API key revoked"); load(); }
    catch (error) { fail(error); }
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); say(`${what} copied`); }
    catch { fail("Copying is blocked by the browser; select the text and copy it by hand."); }
  }
</script>

<header class="head">
  <span class="label">Account</span>
  <h1>API keys</h1>
  <p class="muted">Keys let your applications send messages without signing in. A key works for every session of this account and does not expire until you revoke it.</p>
</header>

<div class="cols">
  <section class="card">
    <span class="label">Your keys</span>
    <div class="stack">
      <form class="row" onsubmit={create}>
        <input class="name" bind:value={name} placeholder="Name, e.g. billing-service" maxlength="64" aria-label="Key name" required>
        <button class="btn">Create API key</button>
      </form>
      {#if fresh}
        <div class="secret">
          Copy this key now. It is shown only once.<br>{fresh}
          <div class="copy"><button class="btn quiet small" onclick={() => copy(fresh, "API key")}>Copy key</button></div>
        </div>
      {/if}
      <ul class="list">
        {#each keys as key (key.id)}
          <li class="spread">
            <div><strong>{key.name}</strong><br><small class="mono muted">{key.prefix}… · created {new Date(key.createdAt).toLocaleDateString()}</small></div>
            <button class="btn danger small" onclick={() => revoke(key)}>Revoke</button>
          </li>
        {:else}
          <li class="empty">No keys yet. Create one to send from your own application.</li>
        {/each}
      </ul>
    </div>
  </section>

  <section class="card">
    <div class="spread"><span class="label">Send with a key</span><button class="btn quiet small" onclick={() => copy(example, "Example")}>Copy</button></div>
    <pre class="code">{example}</pre>
    <p class="muted note">A successful send answers <span class="mono">202</span>. If the session is not linked, it answers <span class="mono">409 session_not_connected</span>.</p>
  </section>
</div>

<style>
  .head { display: grid; gap: 8px; max-width: 640px; margin-bottom: 22px; }
  h1 { font: 800 clamp(2.4rem, 6vw, 4.2rem)/0.95 var(--display); text-transform: uppercase; letter-spacing: 0.01em; }
  .cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
  .name { flex: 1; min-width: 180px; }
  .copy { margin-top: 10px; }
  pre.code { margin-top: 14px; }
  .note { margin-top: 12px; font-size: 0.9rem; }
  @media (max-width: 1080px) { .cols { grid-template-columns: 1fr; } }
</style>
