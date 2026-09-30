<script>
  // The last 24 hours of a session as a strip: one tick per event, placed by time.
  let { events = [] } = $props();

  const DAY = 86_400_000;
  const KIND = {
    "message.sent": "sent",
    "message.received": "received",
    "session.connected": "up",
    "session.disconnected": "down",
    "session.logged_out": "down",
  };

  let ticks = $derived.by(() => {
    const now = Date.now();
    return events
      .map((event) => ({ id: event.id, kind: KIND[event.type] ?? "sent", type: event.type, at: new Date(event.createdAt), age: now - new Date(event.createdAt).getTime() }))
      .filter((tick) => tick.age >= 0 && tick.age <= DAY);
  });
</script>

<div class="trace">
  <div class="strip" role="img" aria-label="{ticks.length} events in the last 24 hours">
    {#each ticks as tick (tick.id)}
      <span class="tick {tick.kind}" style="left:{(1 - tick.age / DAY) * 100}%" title="{tick.type} · {tick.at.toLocaleTimeString()}"></span>
    {/each}
  </div>
  <div class="axis mono"><span>24h ago</span><span>12h</span><span>now</span></div>
  <div class="legend">
    <span><i class="tick sent"></i>Sent</span>
    <span><i class="tick received"></i>Received</span>
    <span><i class="tick up"></i>Connected</span>
    <span><i class="tick down"></i>Disconnected</span>
  </div>
</div>

<style>
  .strip { position: relative; height: 34px; border: 1px solid var(--line); border-radius: 7px; background:
    repeating-linear-gradient(to right, transparent 0, transparent calc(100% / 24 - 1px), var(--line-soft) calc(100% / 24 - 1px), var(--line-soft) calc(100% / 24)), var(--surface); overflow: hidden; }
  .strip .tick { position: absolute; top: 5px; bottom: 5px; width: 3px; margin-left: -1.5px; border-radius: 2px; }
  .tick.sent { background: var(--cord); }
  .tick.received { background: var(--ink); }
  .tick.up { background: var(--lamp-live); }
  .tick.down { background: var(--lamp-down); }
  .strip .tick.up, .strip .tick.down { top: 0; bottom: 0; width: 4px; border-radius: 0; }
  .axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 0.74rem; margin-top: 4px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; font-size: 0.82rem; color: var(--ink-soft); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend .tick { display: inline-block; width: 3px; height: 12px; border-radius: 2px; }
</style>
