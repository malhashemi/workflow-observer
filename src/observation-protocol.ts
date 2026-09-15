export interface EvidenceStamp {
  indexId: string;
  evidenceRevision: number;
}

export function sameStamp(a: EvidenceStamp | null, b: EvidenceStamp | null) {
  return (
    a === b || !!(a && b && a.indexId === b.indexId && a.evidenceRevision === b.evidenceRevision)
  );
}

export function validStamp(value: unknown): value is EvidenceStamp {
  if (!value || typeof value !== "object") return false;
  const s = value as EvidenceStamp;
  return (
    typeof s.indexId === "string" &&
    /^[a-f0-9-]{36}$/.test(s.indexId) &&
    Number.isSafeInteger(s.evidenceRevision) &&
    s.evidenceRevision >= 0
  );
}

export function readStamp(headers: Headers): EvidenceStamp | null {
  const revision = headers.get("X-Observer-Evidence-Revision");
  if (revision === null || !/^\d+$/.test(revision)) return null;
  const stamp = {
    indexId: headers.get("X-Observer-Index") ?? "",
    evidenceRevision: Number(revision),
  };
  return validStamp(stamp) ? stamp : null;
}

export function stampResponse(response: Response, stamp: EvidenceStamp) {
  response.headers.set("X-Observer-Index", stamp.indexId);
  response.headers.set("X-Observer-Evidence-Revision", String(stamp.evidenceRevision));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
