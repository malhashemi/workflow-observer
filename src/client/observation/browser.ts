export interface Changes {
  listen(receive: (token: string) => void): () => void;
  announce(token: string): void;
}
export function browserChanges(): Changes {
  let channel: BroadcastChannel | undefined;
  return {
    listen(receive) {
      try {
        channel = new BroadcastChannel("observer-evidence");
        channel.onmessage = (e) => {
          if (typeof e.data === "string") receive(e.data);
        };
      } catch {
        /* Storage events provide a fallback. */
      }
      const listener = (event: StorageEvent) => {
        if (event.key === "observer.cacheSignal" && event.newValue) receive(event.newValue);
      };
      window.addEventListener("storage", listener);
      // Evidence belongs in IndexedDB; UI preferences remain in localStorage.
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key?.startsWith("observer.library.") || key === "observer.evidenceGeneration")
            localStorage.removeItem(key);
        }
      } catch {
        /* Live observation works without storage. */
      }
      return () => {
        channel?.close();
        channel = undefined;
        window.removeEventListener("storage", listener);
      };
    },
    announce(token) {
      channel?.postMessage(token);
      try {
        localStorage.setItem("observer.cacheSignal", token);
      } catch {
        /* BroadcastChannel still works. */
      }
    },
  };
}
