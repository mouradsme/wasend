<script>
  import { api, setToken } from "../lib/api.js";
  import { fail } from "../lib/toast.svelte.js";
  import Lamp from "../lib/Lamp.svelte";

  let { onSignedIn } = $props();
  let email = $state("");
  let password = $state("");
  let busy = $state(false);

  async function signIn(event) {
    event.preventDefault();
    busy = true;
    try {
      const result = await api("/auth/login", { method: "POST", body: { email, password } });
      setToken(result.token);
      onSignedIn();
    } catch (error) { fail(error); }
    finally { busy = false; }
  }
</script>

<div class="page">
  <section class="panel">
    <div class="brand">WaSend</div>
    <p>WhatsApp messages from your own apps.</p>
    <ul>
      <li><Lamp state="connected" /> Link an account by QR code</li>
      <li><Lamp state="connected" /> Send codes and updates through the API</li>
      <li><Lamp state="connected" /> Get replies on your webhooks</li>
    </ul>
  </section>

  <form class="form stack" onsubmit={signIn}>
    <span class="label">Sign in</span>
    <label class="field"><span>Email</span><input type="email" bind:value={email} autocomplete="username" required></label>
    <label class="field"><span>Password</span><input type="password" bind:value={password} autocomplete="current-password" required></label>
    <button class="btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    <p class="muted hint">Accounts are created by the administrator of this deployment.</p>
  </form>
</div>

<style>
  .page { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .panel { background: var(--rail); color: var(--rail-text); padding: clamp(28px, 6vw, 72px); display: flex; flex-direction: column; justify-content: center; gap: 18px; }
  .brand { font: 800 clamp(3.4rem, 9vw, 6.5rem)/0.9 var(--display); text-transform: uppercase; letter-spacing: 0.02em; color: #fff; }
  .panel p { font-size: 1.15rem; max-width: 26ch; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 10px; }
  li { display: flex; align-items: center; gap: 12px; }
  .form { align-self: center; justify-self: center; width: min(360px, calc(100% - 40px)); padding: 32px 0; }
  .hint { font-size: 0.87rem; }
  @media (max-width: 760px) {
    .page { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .panel { padding: 28px 22px; }
    .form { align-self: start; }
  }
</style>
