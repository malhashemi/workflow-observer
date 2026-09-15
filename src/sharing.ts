import type { Address } from "./companion/types";
/** Shareable endpoints are network addresses confirmed by the companion. Loopback is never a QR fallback. */
export function shareUrl(address: Address | undefined, key?: string, days = 7) {
  if (!address || address.kind === "local") return null;
  const url = new URL(address.url);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (
    address.kind === "tailscale" &&
    (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net"))
  )
    return null;
  if (
    address.kind === "lan" &&
    (url.protocol !== "http:" || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname))
  )
    return null;
  if (key) {
    if (!/^[a-f0-9]{24}$/.test(key) || ![1, 7, 30, 90].includes(days)) return null;
    url.searchParams.set("days", String(days));
    url.hash = "run/" + key;
  }
  return url.href;
}
