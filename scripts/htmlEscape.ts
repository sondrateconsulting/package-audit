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

// Every Unicode Bidi_Control codepoint (Trojan-Source class): the marks ALM/LRM/RLM, the
// embedding/override pair LRE…RLO + PDF, and the isolates LRI…FSI + PDI. These are invisible and
// reorder the VISUAL order of surrounding text without changing its logical order — a spoofing
// vector in prose that is not wrapped in a `unicode-bidi:isolate` field (the dossier's evidence
// code/loc/branchnote spans ARE isolated; auto-generated observation prose and the copy-as-markdown
// mirrors are not, so those strip the controls instead). Stripping is safe: legitimate RTL scripts
// carry their own strong directionality via the LETTERS, never these standalone control codepoints.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROLS, "");
}
