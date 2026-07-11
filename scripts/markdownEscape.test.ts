import { expect, test, describe } from "bun:test";
import { mdCell, mdCode, mdTable } from "./markdownEscape.ts";

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

describe("mdTable — structural cells are escaped", () => {
  test("a cell value cannot inject a pipe column or a live link", () => {
    const out = mdTable(["export", "note"], [["![x](http://e)", "a|b"]]);
    const dataRow = out.split("\n")[2]!;
    expect(dataRow).toBe("| \\!\\[x\\]\\(http://e\\) | a\\|b |");
  });
});
