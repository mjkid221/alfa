import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve the app's TypeScript imports for offline scripts and node:test.
// Node's built-in type stripping handles loading; no bundler or new dependency.
export function resolve(specifier, context, nextResolve) {
  const base = specifier.startsWith("~/")
    ? new URL(`../src/${specifier.slice(2)}`, import.meta.url)
    : specifier.startsWith(".") && context.parentURL
      ? new URL(specifier, context.parentURL)
      : null;
  if (base?.protocol === "file:" && !existsSync(fileURLToPath(base))) {
    const candidate = new URL(`${base.href}.ts`);
    if (existsSync(fileURLToPath(candidate)))
      return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
}
