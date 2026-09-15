/** getRandomValues is available on LAN HTTP origins, where randomUUID/clipboard may not be. */
export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function copyText(value: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      /* Fall back on a LAN HTTP origin. */
    }
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  const active = document.activeElement as HTMLElement | null;
  (document.querySelector("dialog[open]") ?? document.body).append(input);
  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  active?.focus();
  if (!copied) throw new Error("Select and copy the address manually.");
}
