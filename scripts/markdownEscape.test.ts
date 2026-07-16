import { expect, test, describe } from "bun:test";
import { mdCell, mdCode, mdTable, mdUrl } from "./markdownEscape.ts";

describe("mdCell — inline markdown escape-by-construction", () => {
  test("a hostile image cannot form a live `![](url)` juncture", () => {
    const out = mdCell("![beacon](https://evil.example/x.png)");
    expect(out).not.toContain("](https://evil.example/x.png)");
    expect(out).not.toContain("![beacon]");
    expect(out).toBe("\\!\\[beacon\\]\\(https://evil.example/x.png\\)");
  });

  test("a disguised `[text](url)` link is neutralized too", () => {
    expect(mdCell("[click me](https://evil.example)")).toBe("\\[click me\\]\\(https://evil.example\\)");
  });

  test("angle brackets (raw HTML / autolink) are escaped", () => {
    expect(mdCell("<img src=x>")).toBe("\\<img src=x\\>");
  });

  test("backtick (code-span opener) is escaped", () => {
    expect(mdCell("a`b`c")).toBe("a\\`b\\`c");
  });

  test("pipe is escaped so a value cannot add table columns", () => {
    expect(mdCell("a|b")).toBe("a\\|b");
  });

  test("backslash is escaped first, so our own escapes stay literal", () => {
    expect(mdCell("\\[x]")).toBe("\\\\\\[x\\]");
  });

  test("all line-ending variants collapse to a space — including a LONE \\r", () => {
    expect(mdCell("a\r\nb")).toBe("a b"); // CRLF
    expect(mdCell("a\nb")).toBe("a b"); // LF
    expect(mdCell("a\rb")).toBe("a b"); // lone CR — the /\r?\n/ regex used to miss this
  });

  test("Unicode bidi/direction control characters are stripped (Trojan-Source spoofing)", () => {
    // RLO/LRO/PDF/isolates are invisible and reorder the VISUAL order of the pasted line without
    // changing logical order; the plain-text markdown mirror has no unicode-bidi:isolate field, so
    // mdCell removes them. Legitimate text (no standalone controls) is untouched.
    expect(mdCell("a\u202Eb\u202Cc")).toBe("abc"); // RLO … PDF
    expect(mdCell("\u2066spoof\u2069")).toBe("spoof"); // LRI … PDI
    expect(mdCell("re\u200Eact-native")).toBe("react-native"); // LRM inside an identifier
    expect(mdCell("a\u061Cb")).toBe("ab"); // ALM (U+061C) — a Bidi_Control, also stripped
    expect(mdCell("plain-name")).toBe("plain-name"); // no controls → unchanged
  });

  test("an ENTITY-encoded control can't be reconstituted: `&` is escaped so it stays inert text", () => {
    // stripBidiControls removes RAW controls, but a CommonMark renderer would decode `&#x202E;`
    // back into U+202E outside a code span — so `&` is escaped to keep the reference literal.
    expect(mdCell("&#x202E;evil")).toBe("\\&#x202E;evil");
    expect(mdCell("A & B")).toBe("A \\& B"); // GFM renders \& as a literal &
  });

  test("mdCode strips raw bidi controls too (code spans do not bidi-isolate across renderers)", () => {
    expect(mdCode("a\u202Eb")).toBe("`ab`"); // hostile U+202E inside a snippet is removed
  });

  test("plain identifiers pass through unchanged (no over-escaping of - . _ * @ #)", () => {
    // These are NOT inline link/image/HTML formers; leaving them keeps ubiquitous legit values
    // (scoped package names, `file:line`, permalink `#L5`) readable. `@`/`#` are a documented
    // CommonMark-scoped residual: a literal mention is visible and un-disguised, never a hidden link.
    expect(mdCell("@scope/pkg_name-2.0")).toBe("@scope/pkg_name-2.0");
  });
});

describe("mdCode — code spans stay literal", () => {
  test("a snippet with a closing backtick run gets a longer fence", () => {
    const out = mdCode("a ` b `` c");
    expect(out.startsWith("```")).toBe(true);
    expect(out.endsWith("```")).toBe(true);
    expect(out).toContain("a ` b `` c");
  });

  test("empty content is the closest representable span", () => {
    expect(mdCode("")).toBe("` `");
  });

  test("an all-U+0020 value is NOT sacrificially padded (round-trips under CommonMark)", () => {
    // CommonMark strips one space per side ONLY when the content is not entirely spaces, so an
    // all-space value must be emitted without padding or one space would render as three.
    expect(mdCode(" ")).toBe("` `"); // 1 space between single-backtick fences → renders 1 space
    expect(mdCode("   ")).toBe("`   `"); // 3 spaces, not 5
  });

  test("a MIXED-whitespace value IS padded (CommonMark strips edges when content isn't all spaces)", () => {
    // " \t " is not entirely U+0020, so CommonMark WOULD strip its edge spaces — the pad compensates.
    // (A `trim()`-based all-whitespace check would wrongly skip the pad and lose the edge spaces.)
    expect(mdCode(" \t ")).toBe("`  \t  `"); // padded → CommonMark strips one space per side → " \t "
  });
});

describe("mdCell — documented residual: bare mentions/URLs pass as literal, un-disguised text", () => {
  // The escaper closes the disguised-link / auto-loading-image class but deliberately does NOT
  // escape @ / # / : (they pervade legit values like `@scope/pkg` and `file:line`). A value that IS
  // a mention or a bare URL therefore survives as plain visible text — it is never turned into a
  // DISGUISED link, and the reader sees exactly where it points (CommonMark-scoped residual).
  test("a bare URL stays literal and cannot become a disguised link", () => {
    const out = mdCell("https://evil.example/pixel.png?u=1");
    expect(out).toBe("https://evil.example/pixel.png?u=1"); // unchanged: visible, un-disguised
    expect(out).not.toContain("]("); // never a `[label](url)` — the destination is never hidden
  });
  test("an @mention / #ref stays literal", () => {
    expect(mdCell("@acme/team #42")).toBe("@acme/team #42");
  });
});

describe("mdUrl — trusted https permalinks autolink correctly (paren-safe)", () => {
  test("an https URL with parens becomes an angle-bracket autolink with the CORRECT destination", () => {
    // Next.js route-group paths (`src/(auth)/x.ts`) are common; mdCell would escape the parens and
    // GFM keeps `\(`/`\)` inside a bare autolink, pointing the link at the wrong file. `<url>` doesn't.
    expect(mdUrl("https://github.com/o/r/blob/sha/src/(auth)/x.ts#L1")).toBe("<https://github.com/o/r/blob/sha/src/(auth)/x.ts#L1>");
  });
  test("a non-https or malformed URL falls back to escaped inline text — never becomes a link", () => {
    expect(mdUrl("javascript:alert(1)")).toBe(mdCell("javascript:alert(1)")); // scheme not https → escaped text
    expect(mdUrl("https://x y")).toBe(mdCell("https://x y")); // whitespace → not a clean autolink
    expect(mdUrl("https://")).toBe(mdCell("https://")); // hostless → NOT `<https://>` (which CommonMark would still link)
    expect(mdUrl("https:///x")).toBe(mdCell("https:///x")); // empty host (leading /) → fallback
    expect(mdUrl("https://?x")).toBe(mdCell("https://?x")); // query-only, no host → fallback (not a link)
    expect(mdUrl("https://#x")).toBe(mdCell("https://#x")); // fragment-only, no host → fallback
    expect(mdUrl("https://\u202E")).toBe(mdCell("https://\u202E")); // a bidi control can't count as the host → fallback
  });
  test("raw bidi controls are stripped from the autolinked URL (no spoofing via a tampered permalink)", () => {
    expect(mdUrl("https://evil\u202E.com/x")).toBe("<https://evil.com/x>");
  });
});

describe("mdTable — structural cells are escaped", () => {
  test("a cell value cannot inject a pipe column or a live link", () => {
    const out = mdTable(["export", "note"], [["![x](http://e)", "a|b"]]);
    const dataRow = out.split("\n")[2]!;
    expect(dataRow).toBe("| \\!\\[x\\]\\(http://e\\) | a\\|b |");
  });
});
