import { expect, test, describe } from "bun:test";
import { escapeHtml } from "./htmlEscape.ts";

// The dossier's escape-by-construction contract: EVERY dynamic value passes through this ONE
// function, and dynamic values are emitted only into HTML element bodies or double-quoted
// attribute values. This suite is the function's whole behavioral spec — the renderer's own
// adversarial fixtures build on it.

describe("escapeHtml — the five metacharacters", () => {
  test("escapes & < > \" ' — every occurrence, not just the first", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml(`a && b << c >> d "" e ''`)).toBe(
      "a &amp;&amp; b &lt;&lt; c &gt;&gt; d &quot;&quot; e &#39;&#39;",
    );
  });

  test("ampersand is escaped FIRST — pre-escaped input double-escapes (no entity passthrough)", () => {
    // Deliberate: the function treats input as raw text, never as markup. "&lt;" in a source
    // snippet must render literally as "&lt;", so its & must become &amp;.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  test("neutralizes a script-context breakout attempt", () => {
    expect(escapeHtml("</script><script>alert(1)</script>")).toBe(
      "&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("neutralizes attribute-context breakout attempts (double- and single-quoted)", () => {
    expect(escapeHtml(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
    expect(escapeHtml(`' autofocus onfocus='alert(1)`)).toBe("&#39; autofocus onfocus=&#39;alert(1)");
  });
});

describe("escapeHtml — everything else passes through byte-identically", () => {
  test("empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("plain text is unchanged", () => {
    expect(escapeHtml("registerRootComponent from expo @ 50.0.7")).toBe(
      "registerRootComponent from expo @ 50.0.7",
    );
  });

  test("CSV-formula-looking content is NOT html-escaping's problem — unchanged", () => {
    expect(escapeHtml("=cmd|' /C calc'!A0".replace(/'/g, ""))).toBe("=cmd| /C calc!A0");
    expect(escapeHtml("=2+5+cmd")).toBe("=2+5+cmd");
  });

  test("CR/LF and tabs survive (legal in element bodies and quoted attributes)", () => {
    expect(escapeHtml("line1\r\nline2\tend")).toBe("line1\r\nline2\tend");
  });

  test("non-ASCII survives: emoji, CJK, RTL text with directional marks", () => {
    expect(escapeHtml("🙂 中文 עברית ‮gnp.exe")).toBe("🙂 中文 עברית ‮gnp.exe");
  });

  test("property: output differs from input ONLY on the five metacharacters", () => {
    // Every code point below 0x80 plus a unicode sample, one at a time.
    for (let cp = 0; cp < 0x80; cp++) {
      const ch = String.fromCodePoint(cp);
      const escaped = escapeHtml(ch);
      if (`&<>"'`.includes(ch)) {
        expect(escaped).not.toBe(ch);
        expect(escaped.startsWith("&")).toBe(true);
        expect(escaped.endsWith(";")).toBe(true);
      } else {
        expect(escaped).toBe(ch);
      }
    }
  });

  test("no locale/wall-clock dependence: same input, same output, always", () => {
    const hostile = `<a href="x" onclick='y'>&amp;  `;
    expect(escapeHtml(hostile)).toBe(escapeHtml(hostile));
  });
});
