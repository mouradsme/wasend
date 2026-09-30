<script>
  import { api } from "../lib/api.js";
  import { say, fail } from "../lib/toast.svelte.js";

  let form = $state({ slackWebhookUrl: "", email: "", delayMinutes: 5 });
  let emailAvailable = $state(true);
  let loaded = $state(false);
  let saving = $state(false);
  let testing = $state(false);
  let results = $state([]);

  $effect(() => {
    api("/alerts").then((settings) => {
      form = { slackWebhookUrl: settings.slackWebhookUrl ?? "", email: settings.email ?? "", delayMinutes: settings.delayMinutes ?? 5 };
      emailAvailable = settings.emailAvailable !== false;
      loaded = true;
    }).catch(fail);
  });

  async function save(event) {
    event?.preventDefault();
    saving = true;
    try {
      await api("/alerts", { method: "PUT", body: { ...form, delayMinutes: Number(form.delayMinutes) } });
      say("Alerts saved");
      return true;
    } catch (error) { fail(error); return false; }
    finally { saving = false; }
  }

  async function test() {
    results = [];
    if (!(await save())) return;
    testing = true;
    try { results = (await api("/alerts/test", { method: "POST" })).deliveries; }
    catch (error) { fail(error); }
    finally { testing = false; }
  }

  const CHANNEL = { slack: "Slack", email: "Email" };
</script>

<header class="head">
  <span class="label">Account</span>
  <h1>Alerts</h1>
  <p class="muted">Get a message when one of your sessions stops working, so a dead connection never goes unnoticed.</p>
</header>

<div class="cols">
  <form class="card stack" onsubmit={save}>
    <span class="label">Where to send alerts</span>
    <label class="field">
      <span>Slack incoming webhook</span>
      <input class="mono" type="url" bind:value={form.slackWebhookUrl} placeholder="https://hooks.slack.com/services/…" autocomplete="off" disabled={!loaded}>
      <small>Create one in Slack under Apps → Incoming Webhooks and paste its address. Leave empty to turn Slack alerts off.</small>
    </label>
    <label class="field">
      <span>Email address</span>
      <input type="email" bind:value={form.email} placeholder="you@example.com" disabled={!loaded || !emailAvailable}>
      {#if emailAvailable}
        <small>Leave empty to turn email alerts off.</small>
      {:else}
        <small>Email alerts are not set up on this deployment. The README explains how to enable them; Slack alerts work without any setup.</small>
      {/if}
    </label>
    <label class="field delay">
      <span>Wait before alerting</span>
      <div class="row"><input type="number" min="1" max="120" step="1" bind:value={form.delayMinutes} disabled={!loaded}><span class="muted">minutes disconnected</span></div>
      <small>Short drops usually fix themselves within a minute.</small>
    </label>
    <div class="row">
      <button class="btn" disabled={!loaded || saving}>{saving ? "Saving…" : "Save alerts"}</button>
      <button class="btn quiet" type="button" onclick={test} disabled={!loaded || testing}>{testing ? "Sending…" : "Save and send a test alert"}</button>
    </div>
    {#if results.length}
      <ul class="list">
        {#each results as result (result.channel)}
          <li class:bad={!result.ok}>{CHANNEL[result.channel]}: {result.ok ? "test alert delivered" : `failed — ${result.error}`}</li>
        {/each}
      </ul>
    {/if}
  </form>

  <section class="card">
    <span class="label">What triggers an alert</span>
    <ul class="list">
      <li><strong>Disconnected for too long.</strong> A linked session has been offline longer than the wait above. WaSend keeps reconnecting in the background.</li>
      <li><strong>Unlinked.</strong> WhatsApp removed the link, for example from the phone's Linked devices list. Sent straight away, because the session must be paired again.</li>
      <li><strong>Connected again.</strong> Sent after a disconnect alert once the session is back.</li>
    </ul>
    <p class="muted note">Alerts run on the same Cloudflare account as the sessions. If the account's daily usage limit is exhausted, nothing can be sent, so also watch for failed sends in your application.</p>
  </section>
</div>

<style>
  .head { display: grid; gap: 8px; max-width: 640px; margin-bottom: 22px; }
  h1 { font: 800 clamp(2.4rem, 6vw, 4.2rem)/0.95 var(--display); text-transform: uppercase; letter-spacing: 0.01em; }
  .cols { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .delay input { width: 90px; }
  .bad { color: var(--lamp-down-ink); }
  .note { margin-top: 14px; font-size: 0.9rem; }
  @media (max-width: 1080px) { .cols { grid-template-columns: 1fr; } }
</style>
