// htmlEscape.ts — the ONE HTML escape function for the dossier renderer (escape-by-construction).
// Evidence snippets are third-party source code — hostile by definition — so the renderer's
// safety argument is structural: every dynamic value passes through THIS function, and dynamic
// values are emitted ONLY into HTML element bodies or double-quoted attribute values (never into
// script/style/comment/URL contexts — the dossier's single inline <script> is 100% static).
// In those two contexts, escaping the five metacharacters below is sufficient; nothing else is
// touched, so snippets stay byte-recognizable.

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;", // FIRST in spirit: the regex replaces per-character, so '&' never re-escapes
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;", // numeric — &apos; is XML; older HTML parsers don't know it
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}
