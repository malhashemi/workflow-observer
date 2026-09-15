import { randomId } from "../browser-support";
import { sameStamp, validStamp, type EvidenceStamp } from "../../observation-protocol";

export interface CacheHead {
  token: string;
  stamp: EvidenceStamp | null;
}
export interface Stored<T> {
  value: T;
  etag?: string;
}
const HEAD = "@observation-head";
const schema = "observation-v1";
const usableHead = (v: any): v is CacheHead & { schema: string } =>
  v?.schema === schema && typeof v.token === "string" && (v.stamp === null || validStamp(v.stamp));

/** The stamp check and payload operation always share a transaction, including across tabs. */
export class SnapshotStore {
  private opening: Promise<IDBDatabase> | undefined;
  constructor(
    private readonly factory?: IDBFactory,
    private readonly name = "workflow-observer",
  ) {}
  private database() {
    return (this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = (this.factory ?? globalThis.indexedDB).open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
      request.onerror = () => {
        this.opening = undefined;
        reject(request.error);
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.opening = undefined;
        };
        resolve(request.result);
      };
    }).catch((error) => {
      this.opening = undefined;
      throw error;
    }));
  }
  private async transaction<T>(
    write: boolean,
    operation: (store: IDBObjectStore, finish: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", write ? "readwrite" : "readonly");
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Snapshot transaction aborted"));
      try {
        operation(tx.objectStore("snapshots"), (value) => {
          result = value;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
  head(): Promise<CacheHead> {
    return this.transaction(true, (store, finish) => {
      const read = store.get(HEAD);
      read.onsuccess = () => {
        if (usableHead(read.result)) {
          finish(read.result);
          return;
        }
        // v0.6 and earlier stored unscoped payloads. Never hydrate them on migration.
        const head = { schema, token: randomId(), stamp: null };
        store.clear();
        store.put(head, HEAD);
        finish(head);
      };
    });
  }
  confirm(
    expected: CacheHead,
    stamp: EvidenceStamp,
    current: () => boolean,
  ): Promise<CacheHead | null> {
    return this.transaction(true, (store, finish) => {
      const read = store.get(HEAD);
      read.onsuccess = () => {
        const head = read.result;
        if (
          !current() ||
          !usableHead(head) ||
          head.token !== expected.token ||
          (head.stamp?.indexId === stamp.indexId &&
            head.stamp.evidenceRevision > stamp.evidenceRevision)
        ) {
          finish(null);
          return;
        }
        if (sameStamp(head.stamp, stamp)) {
          finish(head);
          return;
        }
        const next = { schema, token: randomId(), stamp };
        store.clear();
        store.put(next, HEAD);
        finish(next);
      };
    });
  }
  invalidate(
    expected: CacheHead,
    current: () => boolean,
    observed?: EvidenceStamp | null,
  ): Promise<CacheHead | null> {
    return this.transaction(true, (store, finish) => {
      const read = store.get(HEAD);
      read.onsuccess = () => {
        if (!current() || !usableHead(read.result) || read.result.token !== expected.token) {
          finish(null);
          return;
        }
        const stamp =
          observed &&
          observed.indexId === expected.stamp?.indexId &&
          observed.evidenceRevision > expected.stamp.evidenceRevision
            ? observed
            : expected.stamp;
        const next = { schema, token: randomId(), stamp };
        store.clear();
        store.put(next, HEAD);
        finish(next);
      };
    });
  }
  read<T>(head: CacheHead, key: string): Promise<{ matched: boolean; data: Stored<T> | null }> {
    return this.transaction(false, (store, finish) => {
      const read = store.get(HEAD);
      read.onsuccess = () => {
        if (read.result?.token !== head.token) {
          finish({ matched: false, data: null });
          return;
        }
        const data = store.get(key);
        data.onsuccess = () =>
          finish({
            matched: true,
            data: data.result?.token === head.token ? data.result.data : null,
          });
      };
    });
  }
  write<T>(
    head: CacheHead,
    key: string,
    data: Stored<T> | null,
    current: () => boolean,
  ): Promise<boolean> {
    return this.transaction(true, (store, finish) => {
      const read = store.get(HEAD);
      read.onsuccess = () => {
        if (!current() || read.result?.token !== head.token) {
          finish(false);
          return;
        }
        if (data === null) store.delete(key);
        else store.put({ token: head.token, data }, key);
        finish(true);
      };
    });
  }
  async close() {
    const opening = this.opening;
    this.opening = undefined;
    (await opening)?.close();
  }
}
