<script>
  import { api, STATE_LABEL } from "../lib/api.js";
  import { say, fail } from "../lib/toast.svelte.js";
  import Lamp from "../lib/Lamp.svelte";
  import Trace from "../lib/Trace.svelte";

  let { id, onState, onDeleted } = $props();
  let base = $derived("/sessions/" + encodeURIComponent(id));

  let status = $state({ state: "", qr: "" });
  let events = $state([]);
  let webhooks = $state([]);
  let deliveries = $state({ pending: 0, failed: [] });
  let newSecret = $state("");
  let pairing = $state(false);
  let sending = $state(false);
  let message = $state({ to: "", kind: "transactional", text: "" });
  let hook = $state({ url: "", secret: "" });

  const HELP = {
    connected: "Linked and online. Messages can be sent and received.",
    pairing: "Open WhatsApp on your phone, go to Linked devices, and scan this code. It refreshes by itself.",
    disconnected: "The connection dropped. WaSend is reconnecting on its own; nothing to do unless this lasts.",
    unpaired: "No WhatsApp account is linked to this session yet.",
    logged_out: "This session was unlinked from its WhatsApp account. Pair it again to keep sending.",
  };

  async function loadStatus() {
    try {
      const next = await api(base);
      status = { state: next.state, qr: next.qr ?? "" };
      onState?.(next.state);
    } catch { /* transient; the next poll retries */ }
  }
  async function loadEvents() { try { events = (await api(base + "/events")).events; } catch { /* keep what is shown */ } }
  async function loadWebhooks() {
    try {
      const [hooks, state] = await Promise.all([api(base + "/webhooks"), api(base + "/webhooks/deliveries")]);
      webhooks = hooks.webhooks;
      deliveries = state;
    } catch (error) { fail(error); }
  }

  // The QR changes every 20–60 seconds, so poll faster while a code is on screen.
  $effect(() => {
    const timer = setInterval(loadStatus, status.state === "pairing" ? 3_000 : 8_000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    loadStatus(); loadEvents(); loadWebhooks();
    const timer = setInterval(loadEvents, 15_000);
    return () => clearInterval(timer);
  });

  async function pair() {
    pairing = true;
    try {
      const next = await api(base + "/pair", { method: "POST" });
      status = { state: next.state, qr: next.qr ?? "" };
      onState?.(next.state);
    } catch (error) { fail(error); }
    finally { pairing = false; }
  }

  async function send(event) {
    event.preventDefault();
    sending = true;
    try {
      await api(base + "/messages", { method: "POST", body: message });
      message.text = "";
      say("Message sent");
      loadEvents();
    } catch (error) { fail(error); }
    finally { sending = false; }
  }

  async function addWebhook(event) {
    event.preventDefault();
    try {
      const created = await api(base + "/webhooks", { method: "POST", body: { url: hook.url, ...(hook.secret ? { secret: hook.secret } : {}) } });
      newSecret = created.secret;
      hook = { url: "", secret: "" };
      say("Webhook added");
      loadWebhooks();
    } catch (error) { fail(error); }
  }
  async function toggleWebhook(item) {
    try { await api(`${base}/webhooks/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { enabled: !item.enabled } }); loadWebhooks(); }
    catch (error) { fail(error); }
  }
  async function removeWebhook(item) {
    if (!confirm(`Remove the webhook to ${item.url}?`)) return;
    try { await api(`${base}/webhooks/${encodeURIComponent(item.id)}`, { method: "DELETE" }); say("Webhook removed"); loadWebhooks(); }
    catch (error) { fail(error); }
  }

  async function remove() {
    if (!confirm(`Delete session "${id}"? This unlinks the WhatsApp account and deletes its webhooks and events.`)) return;
    try { await api(base, { method: "DELETE" }); say("Session deleted"); onDeleted?.(); }
    catch (error) { fail(error); }
  }

  const time = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const summary = (event) => event.data?.text ?? event.data?.to ?? event.data?.from ?? "";
</script>

<header class="head">
  <div>
    <span class="label">Session</span>
    <h1>{id}</h1>
  </div>
  <div class="state {status.state}">
    <Lamp state={status.state} size={14} />
    <strong>{STATE_LABEL[status.state] ?? "Loading…"}</strong>
  </div>
</header>

<section class="card activity">
  <span class="label">Activity, last 24 hours</span>
  <Trace {events} />
</section>

<div class="grid">
  <div class="col">
  <section class="card">
    <span class="label">WhatsApp link</span>
    <div class="stack">
      <p>{HELP[status.state] ?? "Checking the session…"}</p>
      {#if status.state === "pairing" && status.qr}
        <img class="qr" src={status.qr} alt="WhatsApp pairing QR code" width="240" height="240">
      {/if}
      <div class="row">
        {#if status.state && status.state !== "connected" && status.state !== "disconnected"}
          <button class="btn" onclick={pair} disabled={pairing}>{pairing ? "Getting a code…" : status.state === "pairing" ? "Get a new code" : "Pair with WhatsApp"}</button>
        {/if}
        <button class="btn danger" onclick={remove}>Delete session</button>
      </div>
    </div>
  </section>

  <section class="card">
    <span class="label">Send a test message</span>
    <form class="stack" onsubmit={send}>
      <div class="two">
        <label class="field"><span>To</span><input class="mono" bind:value={message.to} placeholder="+15551234567" inputmode="tel" required></label>
        <label class="field"><span>Kind</span>
          <select bind:value={message.kind}><option value="transactional">Transactional</option><option value="otp">One-time code</option></select>
        </label>
      </div>
      <label class="field"><span>Message</span><textarea bind:value={message.text} required></textarea></label>
      <div class="row">
        <button class="btn" disabled={sending || status.state !== "connected"}>{sending ? "Sending…" : "Send message"}</button>
        {#if status.state && status.state !== "connected"}<span class="muted">Link the session first.</span>{/if}
      </div>
    </form>
  </section>
  </div>

  <div class="col">
  <section class="card">
    <span class="label">Webhooks</span>
    <div class="stack">
      <p class="muted">WaSend posts incoming messages and connection changes to these addresses.</p>
      <form class="stack" onsubmit={addWebhook}>
        <label class="field"><span>Address</span><input type="url" bind:value={hook.url} placeholder="https://example.com/hooks/wasend" required></label>
        <label class="field"><span>Signing secret</span><input bind:value={hook.secret} placeholder="Leave empty to generate one" autocomplete="off"></label>
        <div><button class="btn quiet">Add webhook</button></div>
      </form>
      {#if newSecret}
        <div class="secret">Copy this signing secret now. It is shown only once.<br>{newSecret}</div>
      {/if}
      <ul class="list">
        {#each webhooks as item (item.id)}
          <li class="spread">
            <div class="grow"><div class="mono url">{item.url}</div><small class="muted">{item.enabled ? "On" : "Off"}</small></div>
            <div class="row">
              <button class="btn quiet small" onclick={() => toggleWebhook(item)}>{item.enabled ? "Turn off" : "Turn on"}</button>
              <button class="btn danger small" onclick={() => removeWebhook(item)}>Remove</button>
            </div>
          </li>
        {:else}
          <li class="empty">No webhooks yet. Add one to receive incoming messages.</li>
        {/each}
      </ul>
      {#if deliveries.pending || deliveries.failed.length}
        <p class="muted">{deliveries.pending} waiting to be delivered · {deliveries.failed.length} gave up after retries</p>
      {/if}
    </div>
  </section>

  <section class="card">
    <div class="spread"><span class="label">Recent events</span><button class="btn quiet small" onclick={loadEvents}>Refresh</button></div>
    <ul class="list events">
      {#each events as event (event.id)}
        <li>
          <details>
            <summary><span class="mono type">{event.type}</span><span class="what">{summary(event)}</span><span class="muted when">{time(event.createdAt)}</span></summary>
            <pre class="code">{JSON.stringify(event.data, null, 2)}</pre>
          </details>
        </li>
      {:else}
        <li class="empty">Nothing yet. Sent and received messages appear here for 24 hours.</li>
      {/each}
    </ul>
  </section>
  </div>
</div>

<style>
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { font: 800 clamp(2.4rem, 6vw, 4.2rem)/0.95 var(--display); text-transform: uppercase; letter-spacing: 0.01em; overflow-wrap: anywhere; margin-top: 6px; }
  .state { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); }
  .state.connected strong { color: var(--lamp-live-ink); }
  .state.pairing strong { color: var(--lamp-wait-ink); }
  .state.disconnected strong, .state.logged_out strong { color: var(--lamp-down-ink); }

  .activity { margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
  .col { display: grid; gap: 16px; min-width: 0; }
  .two { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 10px; }
  .qr { display: block; border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: #fff; max-width: 100%; height: auto; }
  .grow { min-width: 0; flex: 1; }
  .url { overflow-wrap: anywhere; }

  .events { margin-top: 14px; max-height: 420px; overflow-y: auto; }
  summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: baseline; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .type { font-weight: 500; }
  .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-soft); }
  .when { font-size: 0.82rem; white-space: nowrap; }
  details[open] summary { margin-bottom: 8px; }

  @media (max-width: 1080px) { .grid { grid-template-columns: 1fr; } }
</style>
