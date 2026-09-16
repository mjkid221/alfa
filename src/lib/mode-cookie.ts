import type { ScreenMode } from "~/lib/screen-mode";

/**
 * The screen mode, mirrored into a cookie so the server can render the right
 * page first time.
 *
 * ## The problem this solves
 *
 * Mode lives in the persisted zustand store, which reads `localStorage` — and
 * `localStorage` does not exist on the server. The store therefore runs with
 * `skipHydration`, so SSR renders the **default** mode and the client corrects
 * it a beat later. For a reader who has chosen developer mode that is not a
 * small correction: measured at 1440px, the chain page rendered the whole
 * research page at 4,847px and then replaced it with the developer page at
 * 1,946px — a **2,901px** jump, and the largest single piece of movement left
 * in the app once the loading skeletons were in.
 *
 * A cookie is the one piece of client state the server can see. It is written
 * beside every `localStorage` write and read during SSR, so the first HTML is
 * already the page the reader asked for. `localStorage` stays the source of
 * truth — the cookie only has to be right often enough to pick the correct
 * first paint, and it disagrees only if a reader clears one and not the other.
 *
 * Deliberately **not** `httpOnly`: the client has to write it. It holds one
 * word describing a layout preference, which is why `SameSite=Lax` and a
 * year's expiry are the whole of the security story.
 */
export const MODE_COOKIE = "par.mode";

/** Parses a cookie value, falling back to the default for anything unknown. */
export function modeFromCookie(value: string | undefined): ScreenMode {
  // The fallback is spelled out rather than imported from the store: this file
  // is read by server components, and the store is a client module that would
  // drag zustand and `localStorage` into the server bundle behind it.
  return value === "developer" || value === "research" ? value : "research";
}

/**
 * Writes the cookie. Client-side only, and a no-op anywhere else.
 *
 * Wrapped because `document.cookie` throws in a sandboxed frame, and a
 * preference that cannot be saved must not take the screen down with it.
 */
export function writeModeCookie(mode: ScreenMode): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${MODE_COOKIE}=${mode}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // A reader whose browser refuses cookies gets the old behaviour: one
    // frame of the default mode. Nothing else depends on this.
  }
}
