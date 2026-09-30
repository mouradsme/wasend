interface DnsAnswer { type?: number; data?: string; }

const encoder = new TextEncoder();

export async function validateWebhookUrl(raw: string, allowlist = ""): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Webhook URL is invalid"); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.hash) throw new Error("Webhook URLs must use HTTPS on port 443 without credentials or fragments");
  if (!hostname || hostname.startsWith("[") || !hostname.includes(".") || /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(hostname)) throw new Error("Webhook host must be a public DNS hostname");

  if (allowlist.trim()) {
    const allowed = allowlist.split(",").map(host => host.trim().toLowerCase().replace(/^\*\./, ".")).filter(Boolean);
    if (!allowed.some(host => hostname === host || host.startsWith(".") && hostname.endsWith(host))) throw new Error("Webhook host is not on the configured WEBHOOK_ALLOWED_HOSTS allowlist");
  }

  const answers = await Promise.all([resolve(hostname, "A"), resolve(hostname, "AAAA")]);
  const addresses = answers.flat();
  if (!addresses.length || addresses.some(({ type, data }) => type === 1 ? !publicV4(data ?? "") : type === 28 ? !publicV6(data ?? "") : false)) throw new Error("Webhook host must resolve only to public IP addresses");
  return url;
}

async function resolve(host: string, type: "A" | "AAAA"): Promise<DnsAnswer[]> {
  const target = new URL("https://cloudflare-dns.com/dns-query");
  target.searchParams.set("name", host);
  target.searchParams.set("type", type);
  try {
    const response = await fetch(target, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error("DNS lookup failed");
    const data = await response.json() as { Status?: number; Answer?: DnsAnswer[] };
    if (data.Status !== 0 && data.Status !== 3) throw new Error("DNS lookup failed");
    return (data.Answer ?? []).filter(answer => answer.type === (type === "A" ? 1 : 28));
  } catch { throw new Error("Could not validate webhook host DNS"); }
}

function publicV4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n, i) => !/^\d+$/.test(value.split(".")[i]) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}

function publicV6(value: string): boolean {
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false; // global-unicast 2000::/3 only
  const normalized = value.toLowerCase();
  if (normalized.startsWith("2001:db8:") || normalized === "2001:db8") return false;
  if (normalized.startsWith("2001:0000:") || normalized.startsWith("2002:")) return false;
  return true;
}
