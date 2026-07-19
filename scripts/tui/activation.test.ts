// activation.test.ts — §U8.1: decideTuiActivation table-tested over every §U1 matrix row,
// including CI, TERM=dumb, the size floor, undefined dimensions, --ui error cells, and plan.
import { expect, test, describe } from "bun:test";
import { decideTuiActivation, MIN_COLUMNS, MIN_ROWS, type ActivationInput } from "./activation.ts";

const base: ActivationInput = {
  plan: false,
  uiFlag: null,
  stderrIsTTY: true,
  stdoutIsTTY: true,
  columns: 120,
  rows: 40,
  term: "xterm-256color",
  ci: false,
};
const input = (over: Partial<ActivationInput>): ActivationInput => ({ ...base, ...over });

describe("decideTuiActivation — the §U1 matrix, row by row", () => {
  test("interactive stderr + stdout TTY, auto → on with divert", () => {
    expect(decideTuiActivation(input({}))).toEqual({ mode: "on", divert: true });
  });
  test("interactive stderr + stdout TTY, --ui → on with divert", () => {
    expect(decideTuiActivation(input({ uiFlag: true }))).toEqual({ mode: "on", divert: true });
  });
  test("interactive stderr, stdout piped, auto → on WITHOUT divert (stdout untouched)", () => {
    expect(decideTuiActivation(input({ stdoutIsTTY: false }))).toEqual({ mode: "on", divert: false });
  });
  test("interactive stderr, stdout piped, --ui → on WITHOUT divert", () => {
    expect(decideTuiActivation(input({ stdoutIsTTY: false, uiFlag: true }))).toEqual({ mode: "on", divert: false });
  });

  test("CI set, auto → off (auto mode must never divert in CI)", () => {
    expect(decideTuiActivation(input({ ci: true }))).toEqual({ mode: "off" });
  });
  test("TERM=dumb, auto → off", () => {
    expect(decideTuiActivation(input({ term: "dumb" }))).toEqual({ mode: "off" });
  });
  test("below the size floor, auto → off", () => {
    expect(decideTuiActivation(input({ columns: MIN_COLUMNS - 1 }))).toEqual({ mode: "off" });
    expect(decideTuiActivation(input({ rows: MIN_ROWS - 1 }))).toEqual({ mode: "off" });
  });
  test("exactly the floor is eligible (40x5 is enough)", () => {
    expect(decideTuiActivation(input({ columns: MIN_COLUMNS, rows: MIN_ROWS }))).toEqual({ mode: "on", divert: true });
  });
  test("undefined dimensions are ineligible, auto → off", () => {
    expect(decideTuiActivation(input({ columns: undefined }))).toEqual({ mode: "off" });
    expect(decideTuiActivation(input({ rows: undefined }))).toEqual({ mode: "off" });
  });
  test("NON-INTEGER dimensions are ineligible — NaN/Infinity/fractions must not slip a less-than check", () => {
    // `NaN < 40` is false: a blocker-shaped size test would wave these through eligibility and
    // mount a dashboard that renders the EMPTY frame while the divert reroutes JSONL.
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, 80.5]) {
      expect({ v, d: decideTuiActivation(input({ columns: v })) }).toEqual({ v, d: { mode: "off" } });
      expect({ v, d: decideTuiActivation(input({ rows: v })) }).toEqual({ v, d: { mode: "off" } });
    }
  });
  test("--ui with NaN dimensions fails fast naming the dimension blocker", () => {
    const d = decideTuiActivation(input({ uiFlag: true, columns: Number.NaN }));
    expect(d.mode).toBe("error");
    expect((d as { message: string }).message).toContain("terminal is NaNx40");
  });
  test("stderr not a TTY, auto → off", () => {
    expect(decideTuiActivation(input({ stderrIsTTY: false }))).toEqual({ mode: "off" });
  });

  test("--ui in an ineligible environment → error naming the concrete blocker (fail fast)", () => {
    const ci = decideTuiActivation(input({ uiFlag: true, ci: true }));
    expect(ci.mode).toBe("error");
    if (ci.mode === "error") {
      expect(ci.message).toContain("--ui requires an interactive stderr terminal");
      expect(ci.message).toContain("CI is set");
    }
    const noTty = decideTuiActivation(input({ uiFlag: true, stderrIsTTY: false }));
    expect(noTty.mode).toBe("error");
    if (noTty.mode === "error") expect(noTty.message).toContain("stderr is not a TTY");
    const dumb = decideTuiActivation(input({ uiFlag: true, term: "dumb" }));
    expect(dumb.mode).toBe("error");
    if (dumb.mode === "error") expect(dumb.message).toContain("TERM is 'dumb'");
    const small = decideTuiActivation(input({ uiFlag: true, columns: 20, rows: 3 }));
    expect(small.mode).toBe("error");
    if (small.mode === "error") expect(small.message).toContain("20x3");
  });

  test("--no-ui → off in EVERY environment, incl. fully eligible ones", () => {
    expect(decideTuiActivation(input({ uiFlag: false }))).toEqual({ mode: "off" });
    expect(decideTuiActivation(input({ uiFlag: false, ci: true, stderrIsTTY: false }))).toEqual({ mode: "off" });
  });

  test("plan → off, even in a fully eligible interactive terminal (auto or --no-ui)", () => {
    expect(decideTuiActivation(input({ plan: true }))).toEqual({ mode: "off" });
    expect(decideTuiActivation(input({ plan: true, uiFlag: false }))).toEqual({ mode: "off" });
  });

  test("NO_COLOR is not an input at all: styling never affects routing", () => {
    // structural: ActivationInput has no color field — this documents the deliberate omission
    const keys = Object.keys(base).sort();
    expect(keys).toEqual(["ci", "columns", "plan", "rows", "stderrIsTTY", "stdoutIsTTY", "term", "uiFlag"]);
  });
});
