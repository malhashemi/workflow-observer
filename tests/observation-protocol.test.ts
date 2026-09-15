import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../src/indexer";
import { Catalog } from "../src/catalog";
import { readStamp, stampResponse, validStamp } from "../src/observation-protocol";

test("index identity and revision survive restart; a recreated SQLite index has its own revision scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-identity-"));
  let index = new Indexer([], dir, new Catalog(dir));
  try {
    const identity = index.indexId;
    expect(validStamp(index.evidenceStamp)).toBe(true);
    index.db.run("UPDATE observer_meta SET value=12 WHERE key='evidenceGeneration'");
    index.db.close();
    index = new Indexer([], dir, new Catalog(dir));
    expect(index.evidenceStamp).toEqual({ indexId: identity, evidenceRevision: 12 });
    index.db.close();
    await rm(join(dir, "observer.sqlite"));
    index = new Indexer([], dir, new Catalog(dir));
    expect(index.indexId).not.toBe(identity);
    expect(index.evidenceStamp.evidenceRevision).toBe(0);
  } finally {
    index.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("observation stamps are readable on 200, 304, and 404; malformed revisions are rejected", () => {
  const stamp = { indexId: crypto.randomUUID(), evidenceRevision: 7 };
  for (const status of [200, 304, 404]) {
    const response = stampResponse(new Response(null, { status }), stamp);
    expect(readStamp(response.headers)).toEqual(stamp);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  for (const revision of ["", "-1", "1.5", "Infinity", "9007199254740992", "1e3"])
    expect(
      readStamp(
        new Headers({
          "X-Observer-Index": stamp.indexId,
          "X-Observer-Evidence-Revision": revision,
        }),
      ),
    ).toBeNull();
});
