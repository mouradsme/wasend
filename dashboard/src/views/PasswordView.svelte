<script>
  import { api } from "../lib/api.js";
  import { say, fail } from "../lib/toast.svelte.js";

  let form = $state({ currentPassword: "", newPassword: "", repeat: "" });
  let saving = $state(false);
  let mismatch = $derived(form.repeat !== "" && form.repeat !== form.newPassword);

  async function change(event) {
    event.preventDefault();
    if (form.newPassword !== form.repeat) return fail("The two new passwords do not match.");
    saving = true;
    try {
      await api("/auth/password", { method: "POST", body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
      form = { currentPassword: "", newPassword: "", repeat: "" };
      say("Password changed");
    } catch (error) { fail(error); }
    finally { saving = false; }
  }
</script>

<header class="head">
  <span class="label">Account</span>
  <h1>Password</h1>
  <p class="muted">Change the password you sign in with. Other browsers signed in to this account are signed out; API keys keep working.</p>
</header>

<form class="card stack" onsubmit={change}>
  <span class="label">Change password</span>
  <label class="field"><span>Current password</span><input type="password" bind:value={form.currentPassword} autocomplete="current-password" required></label>
  <label class="field"><span>New password</span><input type="password" bind:value={form.newPassword} autocomplete="new-password" minlength="12" maxlength="256" required><small>At least 12 characters.</small></label>
  <label class="field"><span>New password again</span><input type="password" bind:value={form.repeat} autocomplete="new-password" required>
    {#if mismatch}<small class="bad">This does not match the new password.</small>{/if}
  </label>
  <div><button class="btn" disabled={saving || mismatch}>{saving ? "Changing…" : "Change password"}</button></div>
</form>

<style>
  .head { display: grid; gap: 8px; max-width: 640px; margin-bottom: 22px; }
  h1 { font: 800 clamp(2.4rem, 6vw, 4.2rem)/0.95 var(--display); text-transform: uppercase; letter-spacing: 0.01em; }
  form { max-width: 460px; }
  .field small.bad { color: var(--lamp-down-ink); }
</style>
