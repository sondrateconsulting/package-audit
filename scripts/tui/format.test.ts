// format.test.ts — §U8.6 (sanitizeLine against hostile fixtures) + §U8.11 (formatter tables +
// the pure layout planner: budgets, degradation order, compact/single-line/empty modes).
// Control bytes in fixtures are spelled as \u escapes so the SOURCE stays pure ASCII.
import { expect, test, describe } from "bun:test";
import { sanitizeLine, thousands, formatSpan, formatClock, formatCountdown, formatReset, limitTone, planLayout, WORK_ROWS_MAX, NET_ROWS_MAX, type LayoutDemand } from "./format.ts";

const ESC = "\u001B";
const BEL = "\u0007";
const ST = "\u001B\\";

describe("sanitizeLine (§U0 — hostile bytes render inert)", () => {
  test("strips ANSI CSI sequences (colors, cursor movement, erase)", () => {
    expect(sanitizeLine(`${ESC}[31mred${ESC}[0m plain`)).toBe("red plain");
    expect(sanitizeLine(`${ESC}[2J${ESC}[H${ESC}[?25lwiped`)).toBe("wiped");
    expect(sanitizeLine(`${ESC}[1;31;40mdeep${ESC}[m`)).toBe("deep");
  });
  test("strips OSC sequences (title set, hyperlinks) with BEL and ST terminators", () => {
    expect(sanitizeLine(`${ESC}]0;evil title${BEL}after`)).toBe("after");
    expect(sanitizeLine(`${ESC}]8;;https://evil${ST}link${ESC}]8;;${ST}`)).toBe("link");
  });
  test("strips C0 controls incl. backspace overwrite and BEL", () => {
    expect(sanitizeLine("abc\u0008\u0008xy")).toBe("abcxy"); // backspace cannot overwrite
    expect(sanitizeLine(`ding${BEL}dong`)).toBe("dingdong");
    expect(sanitizeLine("nul\u0000led")).toBe("nulled");
  });
  test("strips C1 controls (0x80–0x9F) incl. raw C1 CSI/OSC introducers", () => {
    expect(sanitizeLine("a\u009B31mb")).toBe("ab"); // raw C1 CSI + params + final consumed
    expect(sanitizeLine("x\u0085y\u0090z")).toBe("xyz");
    expect(sanitizeLine(`o\u009D0;title${BEL}k`)).toBe("ok"); // C1 OSC introducer
  });
  test("strips Unicode bidi/isolate formatting controls (Trojan-Source display spoofing)", () => {
    // Beyond \u00A7U0's C0/C1+ANSI minimum: a hostile branch/repo name could embed RIGHT-TO-LEFT
    // OVERRIDE etc. to visually reorder a dashboard row without any control-byte injection. These
    // display-only formatting chars are stripped as defense-in-depth so the frame reads as authored.
    expect(sanitizeLine("git\u202Ekcatta\u202Cbranch")).toBe("gitkcattabranch"); // RLO + PDF
    expect(sanitizeLine("\u2066a\u2069\u2067b\u2069")).toBe("ab"); // LRI/RLI/PDI isolates
    expect(sanitizeLine("safe\u200E\u200F\u061Cname")).toBe("safename"); // LRM/RLM/ALM marks
    expect(sanitizeLine("\u202A\u202B\u202Dembedded\u202C")).toBe("embedded"); // LRE/RLE/LRO
  });
  test("collapses newlines and CR to ONE display line (CR cannot overwrite)", () => {
    expect(sanitizeLine("line1\nline2\r\nline3\rline4")).toBe("line1 line2 line3 line4");
    expect(sanitizeLine("tab\there")).toBe("tab here");
  });
  test("stray ESC and two-char escapes are consumed; plain text is untouched", () => {
    expect(sanitizeLine(`${ESC}Mhalf`)).toBe("half"); // ESC M (reverse index) consumed
    expect(sanitizeLine(`tail${ESC}`)).toBe("tail"); // a dangling ESC is dropped
    expect(sanitizeLine("plain text stays 100% intact — even · unicode ⏸ 分支")).toBe("plain text stays 100% intact — even · unicode ⏸ 分支");
  });
  test("a fully hostile composite renders inert", () => {
    const hostile = `${ESC}]0;pwn${BEL}${ESC}[2J${ESC}[9999;9999H\r\nCLEAN${ESC}[31mTEXT${ESC}[0m`;
    expect(sanitizeLine(hostile)).toBe(" CLEANTEXT");
  });
});

describe("formatters (§U8.11)", () => {
  test("thousands is locale-pinned", () => {
    expect(thousands(4812)).toBe("4,812");
    expect(thousands(1204)).toBe("1,204");
    expect(thousands(77)).toBe("77");
  });
  test("thousands and formatReset are TOTAL against non-finite and masquerading values", () => {
    // toLocaleString on a runtime STRING returns the string VERBATIM — control bytes included —
    // so anything but a finite number must render as the honest placeholder instead.
    expect(thousands(NaN)).toBe("?");
    expect(thousands(Infinity)).toBe("?");
    expect(thousands(-Infinity)).toBe("?");
    expect(thousands("4812" as unknown as number)).toBe("?");
    expect(thousands(`${String.fromCharCode(0x9d)}0;pwn${String.fromCharCode(0x9c)}` as unknown as number)).toBe("?");
    expect(formatReset(NaN, 0)).toBe("—");
    expect(formatReset("999" as unknown as number, 0)).toBe("—");
    expect(formatReset(999, 0)).toBe("16:39"); // honest epochs still format
  });
  test("formatSpan: decimals under 10s, whole seconds, then minutes", () => {
    expect(formatSpan(800)).toBe("0.8s");
    expect(formatSpan(2_100)).toBe("2.1s");
    expect(formatSpan(41_000)).toBe("41s");
    expect(formatSpan(125_000)).toBe("2m05s");
    expect(formatSpan(-50)).toBe("0.0s"); // clock skew clamps at zero
  });
  test("formatClock: mm:ss and h:mm:ss", () => {
    expect(formatClock(252_000)).toBe("04:12");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(-5_000)).toBe("00:00");
  });
  test("formatCountdown floors at 00:00 — time clears PAUSED, never events", () => {
    expect(formatCountdown(10_000, 5_000)).toBe("00:05");
    expect(formatCountdown(10_000, 20_000)).toBe("00:00");
  });
  test("formatReset from an epoch, or an em-dash when unknown", () => {
    expect(formatReset(1_000, 246_000)).toBe("12:34");
    expect(formatReset(null, 0)).toBe("—");
  });
});

describe("limitTone (M1 — graded rate-limit headroom color)", () => {
  test("red below 10% of the limit, yellow below 25%, uncolored otherwise", () => {
    expect(limitTone(0, 5000)).toBe("red"); // fully exhausted
    expect(limitTone(120, 5000)).toBe("red"); // 2.4%
    expect(limitTone(499, 5000)).toBe("red"); // 9.98%
    expect(limitTone(500, 5000)).toBe("yellow"); // exactly 10% → not red, still low
    expect(limitTone(1249, 5000)).toBe("yellow"); // 24.98%
    expect(limitTone(1250, 5000)).toBeUndefined(); // exactly 25% → healthy
    expect(limitTone(4812, 5000)).toBeUndefined(); // healthy
  });
  test("uncolored unless BOTH remaining and limit are finite and the limit is positive", () => {
    expect(limitTone(null, 5000)).toBeUndefined(); // remaining unknown
    expect(limitTone(1998, null)).toBeUndefined(); // seeded remaining, no limit → no ratio
    expect(limitTone(Number.NaN, 5000)).toBeUndefined();
    expect(limitTone(100, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(limitTone(100, 0)).toBeUndefined(); // degenerate limit — no divide
    expect(limitTone(100, -5)).toBeUndefined();
  });
});

describe("planLayout (§U5 terminal-size discipline)", () => {
  const demand = (over: Partial<LayoutDemand> = {}): LayoutDemand => ({ units: 0, introspections: 0, net: 0, problems: 0, banner: 0, ...over });

  test("mode thresholds: empty → single-line → compact → full", () => {
    expect(planLayout(undefined, 30, demand())).toEqual({ mode: "empty" });
    expect(planLayout(100, undefined, demand())).toEqual({ mode: "empty" });
    expect(planLayout(19, 30, demand())).toEqual({ mode: "empty" });
    expect(planLayout(100, 1, demand())).toEqual({ mode: "empty" });
    expect(planLayout(39, 30, demand())).toEqual({ mode: "single-line" }); // below the §U1 floor, still usable
    expect(planLayout(100, 4, demand())).toEqual({ mode: "single-line" });
    expect(planLayout(59, 30, demand())).toEqual({ mode: "compact" });
    expect(planLayout(100, 11, demand())).toEqual({ mode: "compact" });
    expect(planLayout(60, 12, demand()).mode).toBe("full");
  });

  test("full mode caps rows at the WORK/NET maxima", () => {
    const l = planLayout(120, 40, demand({ units: 50, net: 50, problems: 50, introspections: 3, banner: 2 }));
    expect(l).toEqual({ mode: "full", workRows: WORK_ROWS_MAX, netRows: NET_ROWS_MAX, showFindings: true, problemsCollapsed: false });
  });

  test("degradation order under pressure: net shrinks first, then work, then findings, then problems collapse", () => {
    const heavy = demand({ units: 8, net: 8, problems: 5, introspections: 1, banner: 0 });
    // plenty of rows: everything fits (6 fixed + 8 units + 1 intro + 1 findings + 8 net + 5 problems = 29 ≤ 29)
    expect(planLayout(120, 30, heavy)).toEqual({ mode: "full", workRows: 8, netRows: 8, showFindings: true, problemsCollapsed: false });
    // 25 rows (budget 24): net gives up 5 rows first
    expect(planLayout(120, 25, heavy)).toEqual({ mode: "full", workRows: 8, netRows: 3, showFindings: true, problemsCollapsed: false });
    // 17 rows (budget 16): net exhausted (0), then work shrinks to 3
    expect(planLayout(120, 17, heavy)).toEqual({ mode: "full", workRows: 3, netRows: 0, showFindings: true, problemsCollapsed: false });
    // 13 rows (budget 12): work at 0, findings dropped — that alone reaches the budget
    expect(planLayout(120, 13, heavy)).toEqual({ mode: "full", workRows: 0, netRows: 0, showFindings: false, problemsCollapsed: false });
    // 12 rows (budget 11): the last resort — problems collapse to a one-line count
    expect(planLayout(120, 12, heavy)).toEqual({ mode: "full", workRows: 0, netRows: 0, showFindings: false, problemsCollapsed: true });
  });

  test("zero-demand sections cost zero lines (no phantom budget)", () => {
    const l = planLayout(120, 12, demand());
    expect(l).toEqual({ mode: "full", workRows: 0, netRows: 0, showFindings: true, problemsCollapsed: false });
  });

  test("non-renderable dimensions on EITHER axis are EMPTY: the positive-integer predicate matches the proxy pin", () => {
    // NaN passes every `<` guard (all comparisons false) and used to select FULL with a NaN row
    // budget; fractions/Infinity would corrupt the budget likewise. The planner and the
    // lifecycle proxy must agree on what a valid dimension is.
    const bad = [undefined, 0, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const v of bad) {
      expect({ v, axis: "columns", mode: planLayout(v, 30, demand()).mode }).toEqual({ v, axis: "columns", mode: "empty" });
      expect({ v, axis: "rows", mode: planLayout(120, v, demand()).mode }).toEqual({ v, axis: "rows", mode: "empty" });
    }
    expect(planLayout(120, 30, demand()).mode).toBe("full"); // valid positive integers pass
  });
});
