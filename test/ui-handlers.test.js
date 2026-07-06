/**
 * Static guard for index.html inline event handlers.
 *
 * index.html's script is an ES module, so its top-level bindings are
 * invisible to inline on*="..." attributes (they resolve against window).
 * Every identifier an inline handler touches must therefore be exposed as
 * window.NAME — a missed one fails silently in the browser (ReferenceError
 * on click, button appears dead). This scan catches that at test time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");

// browser globals inline handlers may legitimately use
const ALLOWED = new Set(["event", "this", "window", "document", "navigator", "location"]);
const KEYWORDS = new Set(["true", "false", "null", "undefined", "new", "typeof", "void", "in", "of", "if", "else", "return"]);

describe("index.html inline handlers", () => {
  const exposed = new Set(
    [...html.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]));

  it("only reference window-exposed functions or browser globals", () => {
    const offenders = [];
    // strip template interpolations BEFORE attribute extraction — they are
    // module-side code and may contain double quotes that would otherwise
    // truncate the attribute match
    const flat = html.replace(/\$\{[^}]*\}/g, "");
    for (const m of flat.matchAll(/\son[a-z]+="([^"]*)"/g)) {
      const code = m[1]
        .replace(/'[^']*'/g, "''");    // string literals
      for (const id of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g)) {
        const name = id[2];
        if (KEYWORDS.has(name) || ALLOWED.has(name) || exposed.has(name)) continue;
        offenders.push(`${name}  in  on*="${m[1]}"`);
      }
    }
    expect(offenders, "handlers referencing module-scoped identifiers:\n" + offenders.join("\n")).toEqual([]);
  });
});
