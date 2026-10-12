import {
  NEWS_CATEGORIES,
  type NewsCategory,
} from "~/server/domain/news-classify";
import type { NewsDirection } from "~/server/domain/types";

/**
 * How a headline reads.
 *
 * The badge says **bullish or bearish**, on every headline the classifier has
 * read. It used to appear only above a confidence threshold, and that left a
 * third of the feed bare, including headlines that plainly lean one way; the
 * measurement in `server/sources/typesafe.ts` found the lean right 92% of the
 * time where a headline had one. So the threshold now picks the badge's form
 * rather than whether it exists:
 *
 *   Bullish        a clear reading — filled, solid dot
 *   Leans bullish  the model was unsure, or the page is a prediction or
 *                  listicle — outlined, hollow dot, and the word says so
 *
 * Three cues rather than one, because a lean is the noise this change accepted
 * and the reader should be able to discount it without a legend: the wording,
 * the hollow glyph and the missing fill all say the same thing.
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
  leaning,
  category,
}: {
  direction: NewsDirection | null;
  leaning: boolean;
  category: NewsCategory | null;
}) {
  const { label, negative, lean } = resolve(direction, leaning, category) ?? {};
  if (!label) return null;

  const color = negative ? "var(--color-critical)" : "var(--color-good)";

  // The outline is an inset shadow, not a border, so both forms are the same
  // size: a border would make every leaning row 2px taller than its skeleton.
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium"
      style={
        lean
          ? {
              color,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 38%, transparent)`,
            }
          : {
              color,
              background: `color-mix(in oklab, ${color} 12%, transparent)`,
            }
      }
    >
      <span
        className="size-1.5 rounded-full"
        style={
          lean
            ? { boxShadow: `inset 0 0 0 1px ${color}` }
            : { background: color }
        }
        aria-hidden
      />
      {label}
    </span>
  );
}

function resolve(
  direction: NewsDirection | null,
  leaning: boolean,
  category: NewsCategory | null,
) {
  if (direction) {
    const side = direction === "bearish" ? "bearish" : "bullish";
    return {
      label: leaning
        ? `Leans ${side}`
        : side === "bearish"
          ? "Bearish"
          : "Bullish",
      negative: direction === "bearish",
      lean: leaning,
    };
  }

  if (category) {
    const { label, tone } = NEWS_CATEGORIES[category];
    return { label, negative: tone === "negative", lean: false };
  }

  return null;
}
