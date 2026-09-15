// Migrate browsers that visited the former PWA. New visits never register a worker.
export async function retireLegacyWorker() {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations();
    for (const registration of registrations ?? []) {
      const worker = registration.active ?? registration.waiting ?? registration.installing;
      if (worker?.scriptURL === new URL("/sw.js", location.origin).href) {
        await registration.update().catch(() => {});
        await registration.unregister();
      }
    }
    if ("caches" in window)
      for (const name of await caches.keys())
        if (/^observer-v[\d.]+$/.test(name)) await caches.delete(name);
  } catch {
    // Disabled browser storage must not prevent loading the local app.
  }
}
