// Thin client for the WaSend REST API. The login token lives in sessionStorage, so closing the tab signs out.

const KEY = "wasend_token";
let token = sessionStorage.getItem(KEY) || "";
let onSignedOut = () => {};

export const hasToken = () => Boolean(token);
export function setToken(value) { token = value || ""; if (token) sessionStorage.setItem(KEY, token); else sessionStorage.removeItem(KEY); }
export function whenSignedOut(handler) { onSignedOut = handler; }

export async function api(path, { method = "GET", body } = {}) {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) return (await import("./demo.js")).demo(path, method);
  const response = await fetch("/v1" + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty or non-JSON body */ }
  if (response.status === 401 && path !== "/auth/login" && token) { setToken(""); onSignedOut(); }
  if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`);
  return data;
}

export const STATE_LABEL = {
  connected: "Connected",
  pairing: "Waiting for scan",
  disconnected: "Reconnecting",
  unpaired: "Not linked",
  logged_out: "Unlinked",
};
