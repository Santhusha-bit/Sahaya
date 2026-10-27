"use client";

import { useEffect } from "react";

/** Registers the offline/installability service worker in production builds. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // Installability degrades gracefully; the app works without the worker.
    });
  }, []);
  return null;
}
