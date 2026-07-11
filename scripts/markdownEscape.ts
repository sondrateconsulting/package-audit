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

const NEWLINES = /\r\n|[\r\n]/g;
const INLINE_ACTIVE = /[`[\]()!<>|]/g;

export const mdCell = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(INLINE_ACTIVE, (c) => `\\${c}`)
    .replaceAll(NEWLINES, " ");

// Markdown CODE SPAN — dynamic fence, literal content. Code spans are literal in CommonMark, so
// mdCell's backslash escaping would corrupt them; instead the fence is one backtick longer than
// the longest run inside (space-padded, the CommonMark rule), so a hostile snippet can never close
// the span early and smuggle live markdown — e.g. a link — into the copied text.
export const mdCode = (value: string): string => {
  const flat = value.replaceAll(NEWLINES, " ");
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
