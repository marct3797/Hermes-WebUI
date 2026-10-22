import { useSyncExternalStore } from "react";

/** Folgt einer Media Query. Ohne `matchMedia` (Tests, sehr alte Browser) gilt sie als nicht erfüllt. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = typeof matchMedia === "function" ? matchMedia(query) : undefined;
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    () => (typeof matchMedia === "function" ? matchMedia(query).matches : false),
    () => false,
  );
}
