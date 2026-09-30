<script>
  // A panel lamp: the one place session state is shown as colour.
  let { state = "unpaired", size = 10 } = $props();
</script>

<span class="lamp {state}" style="--size:{size}px" aria-hidden="true"></span>

<style>
  .lamp { display: inline-block; flex: none; width: var(--size); height: var(--size); border-radius: 50%; background: var(--lamp-idle); }
  .connected { background: var(--lamp-live); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lamp-live) 22%, transparent); }
  .pairing { background: var(--lamp-wait); animation: blink 1.4s ease-in-out infinite; }
  .disconnected { background: var(--lamp-down); animation: blink 0.9s ease-in-out infinite; }
  .logged_out { background: transparent; border: 2px solid var(--lamp-down); }
  @keyframes blink { 50% { opacity: 0.3; } }
</style>
