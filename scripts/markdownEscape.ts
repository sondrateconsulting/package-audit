// markdownEscape.ts — the markdown counterpart to htmlEscape.ts. The dossier and the index page
// each expose a "copy as markdown" mirror. The output grammar is COMMONMARK / GitHub-Flavored
// Markdown (the copied text is pasted into a markdown renderer — GitHub issues/PRs are the natural
// target). It is deliberately NOT Slack mrkdwn or any other non-CommonMark dialect: those use
// different delimiters and do not honor CommonMark backslash escapes, so a single escaped string
// cannot serve both — the feature produces CommonMark and is safe under CommonMark's rules.
// Attacker-controlled values reach these mirrors (export names are ES2022 arbitrary-string exports
// decoded verbatim; file paths and branch names come from scanned repos), so the mirror needs the
// same escape-by-construction discipline the HTML side gets from escapeHtml. This is the ONE place
// that discipline lives, shared by reportHtml.ts and indexHtml.ts so the two mirrors can never
// drift apart in safety.
//
// mdCell NEUTRALIZES every inline construct that could turn hostile text into a DISGUISED or
// AUTO-LOADING element when the copied markdown is rendered — the class that lets an attacker hide
// where a link points or make the reader's client fetch a resource without a click:
//   - links / images: `[` `]` `(` `)` `!`  → a payload like `![x](https://evil/beacon.png)` can no
//     longer form a live image (a beacon the reader's client auto-fetches) or a disguised
//     `[innocent text](https://evil)` phishing link
//   - raw HTML / autolinks: `<` `>`  → no injected `<img>`/`<a>`/angle-bracket autolink
//   - code spans: backtick (prevents smuggling a live span)
//   - table structure: `|`  (a cell value must not add columns)
//   - line endings: `\r\n`, lone `\r`, lone `\n` → a single space (a value must not start a new row)
// Backslash is escaped FIRST so the escapes we add are themselves literal. CommonMark/GFM strips a
// backslash before ASCII punctuation on render, so the human-visible TEXT output is unchanged —
// `\!\[x\]\(...\)` renders as `![x](...)` text, inert. (One cosmetic exception, inside the bare-URL
// residual below: GFM does NOT strip escapes inside an autolinked URL, so a value that IS a bare
// `https://…(…)` URL shows its `\(`/`\)` literally in the linked text — a display artifact, not a
// new link and not a hidden destination.)
//
// WHY NOT ALSO `@` / `#` / `:`  (the mention / issue-ref / emoji-shortcode / URL-scheme chars):
// they ARE ASCII punctuation and CommonMark WOULD honor a backslash before them, but escaping them
// buys nothing against the disguised-link/auto-image class (that needs `[` `]` `(` `)` `!` `<` `>`,
// all escaped above) and only clutters the ubiquitous LEGIT values these mirrors carry — scoped
// package names (`@scope/pkg`), evidence locations (`src/foo.ts:12`), permalink line refs (`…#L5`).
// So we leave them.
//
// ACCEPTED RESIDUAL (documented, CommonMark-scoped): a value that is itself a bare `https://…` URL
// autolinks to ITSELF (destination visible, never disguised), and on GitHub a literal `@name` /
// `#123` may render as a mention/ref. These are visible, un-disguised, and exactly what the reader
// sees — the mirror never CREATES a link nor HIDES where one points, and the copied evidence is
// read by a human before it is pasted. This residual is inherent to a plain-text copy affordance
// and is orders below the disguised-link / auto-loading-image class the escaping above closes.
// (Pasting into a NON-CommonMark renderer such as Slack mrkdwn is out of scope — see the module
// header; that grammar's `<url|label>` and escaping rules differ and are not what this produces.)

import { stripBidiControls } from "./htmlEscape.ts";

const NEWLINES = /\r\n|[\r\n]/g;
// `&` is escaped so a numeric/entity reference cannot survive into the paste: CommonMark decodes
// `&#x202E;` (etc.) to its character OUTSIDE a code span, which would reconstitute a stripped bidi
// override or other control from literal text. `\&` renders as a literal `&`, so the reference stays
// inert text. (Entities can't recreate markdown STRUCTURE per CommonMark §6.2, but they can recreate
// a character, so stripping raw controls is not enough on its own.)
const INLINE_ACTIVE = /[&`[\]()!<>|]/g;

// The copy-as-markdown mirror is plain text with no `unicode-bidi:isolate` field to contain a
// hostile RTL/override control (the HTML side has that CSS; markdown has no styling), so mdCell
// strips the raw bidi controls up front AND escapes `&` (above) so an entity-encoded one can't be
// decoded back — a value can neither form a link/image/HTML construct nor visually reorder the paste.
export const mdCell = (value: string): string =>
  stripBidiControls(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(INLINE_ACTIVE, (c) => `\\${c}`)
    .replaceAll(NEWLINES, " ");

// A trusted absolute https URL (an evidence permalink) is emitted as an ANGLE-BRACKET autolink, so
// a path containing `(` / `)` — e.g. a Next.js route group `src/(auth)/x.ts` — keeps a CORRECT link
// destination. mdCell would backslash-escape the parens, and GFM RETAINS those backslashes INSIDE an
// autolinked bare URL, silently pointing the link at the wrong file. Bidi controls are stripped
// FIRST, then the stripped value must be `https://` FOLLOWED BY a non-delimiter character (a SYNTACTIC
// delimiter check, not real host validation — e.g. `https://:` still passes) — not `/`, `?`,
// `#`, whitespace, `<`/`>`, or backtick — and must contain no whitespace, `<`/`>`, or backtick
// anywhere (`/`, `?`, `#` stay allowed in the path/query). So a hostless
// `https://`, a query/fragment-only `https://?x`, or a value whose only "host" was a bidi control all
// fall back to escaped inline TEXT and never become a link (buildPermalink emits a well-formed URL;
// the fallback is defense-in-depth for a malformed/tampered value).
export const mdUrl = (url: string): string => {
  const clean = stripBidiControls(url);
  return /^https:\/\/[^\s/<>`?#]/.test(clean) && !/[\s<>`]/.test(clean) ? `<${clean}>` : mdCell(url);
};

// Markdown CODE SPAN — dynamic fence, literal content. Code spans are literal in CommonMark, so
// mdCell's backslash escaping would corrupt them; instead the fence is one backtick longer than
// the longest run inside (space-padded, the CommonMark rule), so a hostile snippet can never close
// the span early and smuggle live markdown — e.g. a link — into the copied text.
export const mdCode = (value: string): string => {
  // Strip raw bidi controls even inside code spans: CommonMark code spans render content literally
  // but do NOT bidi-isolate it, so a hostile U+202E in a snippet would still reorder the copied line
  // in the destination renderer (the HTML side isolates via `code { unicode-bidi:isolate }` CSS,
  // which is not carried into a paste). Entities are inert here (§6.2: not decoded in code spans).
  const flat = stripBidiControls(value).replaceAll(NEWLINES, " ");
  if (flat === "") return "` `"; // the closest representable span — an empty one is not a span at all
  const longest = flat.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(longest + 1);
  // Pad ONLY when CommonMark needs it: a backtick edge would merge with the fence, and space
  // edges need sacrificial padding (the renderer strips one space per side when content begins
  // AND ends with a space). Two exceptions must NOT be padded, or padding would corrupt the
  // content: (1) unconditional padding would ADD spaces to plain content, and (2) a value that is
  // ALL U+0020 SPACES — CommonMark only strips the sacrificial space when the content is NOT
  // entirely spaces, so padding "  " would render four spaces, not two. The predicate is U+0020-only
  // (`/^ *$/`, NOT `trim()`): CommonMark's no-strip exception is spaces, so a mixed value like
  // " \t " DOES get stripped and still needs the pad. mdCode(" ") must round-trip to one space.
  const allSpaces = /^ *$/.test(flat);
  const pad = flat.startsWith("`") || flat.endsWith("`") || (!allSpaces && (flat.startsWith(" ") || flat.endsWith(" "))) ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
};

export const mdTable = (header: readonly string[], rows: ReadonlyArray<readonly string[]>): string =>
  [
    `| ${header.map(mdCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`),
  ].join("\n");
