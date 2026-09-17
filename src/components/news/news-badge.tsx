import {
  NEWS_CATEGORIES,
  type NewsCategory,
} from "~/server/domain/news-classify";
import type { NewsDirection } from "~/server/domain/types";

/**
 * How a headline reads.
 *
 * The badge says **bullish or bearish**. It used to name the event instead —
 * "Exploit", "Listing", "Price up" — because the local classifier was measured
 * doing both and was only reliable at the first: a headline says what happened
 * more reliably than it says what that means. A model reads the second half
 * well enough to show, and more to the point knows when it does not, so the
 * direction is shown only above a confidence threshold. See
 * `server/sources/typesafe.ts` for the measurements.
 *
 * `category` is the fallback, not a second badge. The direction comes from the
 * one paid source in this app, so it is absent whenever the key is unset, out
 * of credit or rate limited — and in that case naming the event is still better
 * than an empty row. Both never render at once.
 *
 * Tone uses the **status** tokens, not the diverging pair. Blue and red are
 * reserved across this app for cheap and expensive, and a headline is neither.
 * Status colour is allowed here because the badge always carries its own words,
 * so nothing rests on the colour alone.
 */
export function NewsBadge({
  direction,
  category,
}: {
  direction: NewsDirection | null;
  category: NewsCategory | null;
}) {
  const { label, negative } = resolve(direction, category) ?? {};
  if (!label) return null;

  const color = negative ? "var(--color-critical)" : "var(--color-good)";

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
      }}
    >
      <span
        className="size-1 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}

function resolve(
  direction: NewsDirection | null,
  category: NewsCategory | null,
) {
  if (direction) {
    return {
      label: direction === "bearish" ? "Bearish" : "Bullish",
      negative: direction === "bearish",
    };
  }

  if (category) {
    const { label, tone } = NEWS_CATEGORIES[category];
    return { label, negative: tone === "negative" };
  }

  return null;
}
