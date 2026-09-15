import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { CompanionSnapshot } from "../companion/types";
import { shareUrl } from "../sharing";
import { copyText } from "./browser-support";
export function ShareDialog({
  companion,
  online,
  runKey,
  runName,
  days = 7,
  onClose,
}: {
  companion?: CompanionSnapshot;
  online: boolean;
  runKey?: string;
  runName?: string;
  days?: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<"lan" | "tailscale">(companion?.sharingDefault ?? "tailscale");
  const [lanUrl, setLanUrl] = useState("");
  const [feedback, setFeedback] = useState("");
  const addresses = online ? (companion?.addresses ?? []) : [];
  const selected = addresses.find(
    (a) => a.kind === kind && (kind !== "lan" || !lanUrl || a.url === lanUrl),
  );
  const url = shareUrl(selected, runKey, days);
  const qr = useMemo(() => (url ? QRCode.create(url, { errorCorrectionLevel: "M" }) : null), [url]);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      node.close();
      document.body.style.overflow = before;
    };
  }, []);
  const size = qr ? qr.modules.size + 8 : 0;
  const path = qr
    ? Array.from(qr.modules.data, (dark, i) =>
        dark ? `M${(i % qr.modules.size) + 4} ${Math.floor(i / qr.modules.size) + 4}h1v1h-1z` : "",
      ).join("")
    : "";
  return (
    <dialog
      ref={dialog}
      className="share-dialog"
      aria-labelledby="share-title"
      aria-describedby="share-description"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          onClose();
      }}
    >
      <div className="share-header">
        <div>
          <span className="eyebrow">Continue on another device</span>
          <h2 id="share-title">{runKey ? "Share this workflow" : "Open Observer on your phone"}</h2>
        </div>
        <button className="modal-close" aria-label="Close sharing" onClick={onClose} autoFocus>
          ×
        </button>
      </div>
      <p id="share-description">
        {runKey ? (
          <>
            <strong>{runName}</strong>
            <br />
            Scan to open this workflow directly.
          </>
        ) : (
          "Scan to browse your sessions and workflows."
        )}
      </p>
      <div className="share-network" role="group" aria-label="Sharing network">
        {(["tailscale", "lan"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={kind === value}
            className={kind === value ? "selected" : ""}
            onClick={() => {
              setKind(value);
              setFeedback("");
            }}
          >
            <span>{value === "tailscale" ? "Tailscale" : "Local network"}</span>
            {companion?.sharingDefault === value ? <small>Default</small> : null}
          </button>
        ))}
      </div>
      {kind === "lan" && addresses.filter((a) => a.kind === "lan").length > 1 ? (
        <label className="share-interface">
          Network address
          <select value={selected?.url ?? ""} onChange={(e) => setLanUrl(e.target.value)}>
            {addresses
              .filter((a) => a.kind === "lan")
              .map((a) => (
                <option key={a.url} value={a.url}>
                  {a.url}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {url && qr ? (
        <>
          <div className="qr-frame">
            <svg
              role="img"
              aria-label="QR code for the selected network link"
              data-share-url={url}
              viewBox={`0 0 ${size} ${size}`}
              shapeRendering="crispEdges"
            >
              <rect width={size} height={size} fill="#ffffff" />
              <path d={path} fill="#031119" />
            </svg>
          </div>
          <div className="share-link">
            <code>{url}</code>
            <button
              onClick={async () => {
                try {
                  await copyText(url);
                  setFeedback("Link copied.");
                } catch (e) {
                  setFeedback(String(e));
                }
              }}
            >
              Copy link
            </button>
          </div>
        </>
      ) : (
        <div className="share-unavailable">
          <span className="badge quiet">Unavailable</span>
          <h3>
            {!online
              ? "Connect to Observer first"
              : `${kind === "tailscale" ? "Tailscale" : "Local network"} access isn’t ready`}
          </h3>
          <p>
            {!online
              ? "A live companion connection is needed to confirm a shareable address."
              : `Enable ${kind === "tailscale" ? "Tailscale" : "local-network"} access in Settings, or choose another available network above.`}
          </p>
          <a href="#settings/access" onClick={onClose}>
            Open access settings ↗
          </a>
        </div>
      )}
      <p className="share-help">
        {kind === "tailscale"
          ? "Connect the other device to your Tailscale network."
          : "Connect the other device to the same local network."}{" "}
        Keep this computer and Observer running.
      </p>
      <p className="share-feedback" role="status">
        {feedback || "The QR contains only this link. Your transcripts stay on this computer."}
      </p>
    </dialog>
  );
}
export function ShareButton({
  onClick,
  compact = false,
}: {
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button onClick={onClick} aria-label="Share with QR code" className="share-button">
      <svg
        viewBox="0 0 24 24"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 15h2v6h-6v-2M3 12h4m5-9v4m0 5h4m-4 4v5" />
      </svg>
      {!compact ? "Share" : ""}
    </button>
  );
}
