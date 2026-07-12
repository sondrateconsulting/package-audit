import { expect, test, describe } from "bun:test";
import { csvCell, toCsv } from "./csvWrite.ts";

// The export layer's CSV contract (EXPORTS.md): RFC 4180 quoting, CRLF row endings, stable
// column order supplied by the caller, and the OWASP formula-injection defense on STRING cells.
// JSONL stays byte-faithful — the defense lives here and only here.

describe("csvCell — RFC 4180 quoting", () => {
  test("plain strings pass through unquoted", () => {
    expect(csvCell("expo")).toBe("expo");
    expect(csvCell("a b c")).toBe("a b c");
  });

  test("comma, double-quote, CR and LF force quoting; embedded quotes double", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  test("numbers serialize bare — never quoted, never formula-prefixed", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-5)).toBe("-5"); // typed number: '-' here is a sign, not a formula trigger
    expect(csvCell(0)).toBe("0");
  });

  test("null is the empty field", () => {
    expect(csvCell(null)).toBe("");
  });

  test("integers only — a fractional or non-finite number is a contract bug, loudly", () => {
    // Export columns are TEXT/INTEGER; a float or NaN reaching the writer means a registry
    // drift, and silently serializing it would bake the drift into golden files.
    expect(() => csvCell(1.5)).toThrow();
    expect(() => csvCell(Number.NaN)).toThrow();
    expect(() => csvCell(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("csvCell — OWASP formula-injection defense (string cells only)", () => {
  test.each([
    ["=cmd|' /C calc'!A0", `'=cmd|' /C calc'!A0`], // apostrophes never trigger RFC quoting
    ["=2+5", "'=2+5"],
    ["+2+5", "'+2+5"],
    ["-2+5", "'-2+5"],
    ["@SUM(A1)", "'@SUM(A1)"],
  ])("prefixes %s", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  test("tab-led and CR-led variants are caught (the leading control char is itself a trigger)", () => {
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`); // CR also forces RFC quoting
  });

  test("leading-whitespace-then-trigger is neutralized (a first-byte-only check misses it)", () => {
    // Some spreadsheet imports trim a leading space and then evaluate the formula; neutralize any
    // cell whose first visible char after leading whitespace is `= + - @` so ` =cmd|...` cannot slip through un-prefixed.
    expect(csvCell(" =cmd|' /C calc'!A0")).toBe("' =cmd|' /C calc'!A0");
    expect(csvCell("  -2+5")).toBe("'  -2+5");
    expect(csvCell("\t\t=1+1")).toBe("'\t\t=1+1"); // leading tabs (no CR, so no RFC quoting)
    expect(csvCell("\u00A0=1+1")).toBe("'\u00A0=1+1"); // a non-breaking space counts as whitespace
  });

  test("benign leading whitespace before a NON-trigger char is NOT over-neutralized", () => {
    // The trigger is whitespace-THEN-`= + - @` (or a leading TAB/CR), not any leading whitespace.
    // A stray-spaced version or path must pass through unprefixed — `^`, digits, letters are safe.
    expect(csvCell(" ^50.0.0")).toBe(" ^50.0.0");
    expect(csvCell("  src/index.ts")).toBe("  src/index.ts");
    expect(csvCell(" 42")).toBe(" 42"); // string " 42" (not a typed number) still passes through
  });

  test("the prefix is a literal apostrophe INSIDE the field, applied before RFC quoting", () => {
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
  });

  test("non-leading formula characters are untouched", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("expo@50.0.7")).toBe("expo@50.0.7");
    expect(csvCell("react-native")).toBe("react-native");
  });
});

describe("toCsv — document assembly", () => {
  test("header row + data rows, CRLF endings, trailing CRLF", () => {
    const out = toCsv(["name", "line"], [["expo", 12], ["=evil", 3]]);
    expect(out).toBe("name,line\r\nexpo,12\r\n'=evil,3\r\n");
  });

  test("empty rows array yields the header alone", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });

  test("row width must match the header — a short or long row is a loud error", () => {
    expect(() => toCsv(["a", "b"], [["only-one"]])).toThrow();
    expect(() => toCsv(["a"], [["x", "y"]])).toThrow();
  });

  test("byte-deterministic: same input, same bytes", () => {
    const header = ["org", "repo", "snippet"] as const;
    const rows = [["o", "r", 'import { x } from "expo"\nnext']];
    expect(toCsv(header, rows)).toBe(toCsv(header, rows));
  });

  test("header cells go through the same escaping (defense-in-depth)", () => {
    expect(toCsv(["a,b"], [])).toBe('"a,b"\r\n');
  });
});
