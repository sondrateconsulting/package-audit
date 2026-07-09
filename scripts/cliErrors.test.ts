import { expect, test, describe } from "bun:test";
import { isKnownOperatorError, renderFatal } from "./cliErrors.ts";
import { ArgsError, ORCHESTRATE_USAGE } from "./args.ts";
import { PreflightError } from "./preflight.ts";
import { ConfigError } from "./config.ts";
import { ReadOnlyViolation } from "./readOnlyGuard.ts";

const OPTS = { command: "orchestrate", usage: ORCHESTRATE_USAGE };

describe("isKnownOperatorError", () => {
  test("recognizes the operator-facing classes by name", () => {
    expect(isKnownOperatorError(new ArgsError("unknown argument '--wat'"))).toBe(true);
    expect(isKnownOperatorError(new PreflightError("not authenticated"))).toBe(true);
    expect(isKnownOperatorError(new ConfigError("cutoffDate must be YYYY-MM-DD"))).toBe(true);
    expect(isKnownOperatorError(new ReadOnlyViolation("READ-ONLY VIOLATION: git push"))).toBe(true);
  });
  test("recognizes a plain Error carrying the READ-ONLY VIOLATION prefix", () => {
    expect(isKnownOperatorError(new Error("READ-ONLY VIOLATION: rewrapped"))).toBe(true);
  });
  test("rejects plain errors and non-errors", () => {
    expect(isKnownOperatorError(new Error("boom"))).toBe(false);
    expect(isKnownOperatorError(new TypeError("undefined is not a function"))).toBe(false);
    expect(isKnownOperatorError("string")).toBe(false);
    expect(isKnownOperatorError(null)).toBe(false);
  });
});

describe("renderFatal", () => {
  test("ArgsError: message + usage synopsis + help hint, NO stack", () => {
    const out = renderFatal(new ArgsError("unknown argument '--wat'"), OPTS);
    expect(out).toContain("orchestrate failed: unknown argument '--wat'");
    expect(out).toContain(ORCHESTRATE_USAGE);
    expect(out).toContain("--help");
    expect(out).not.toContain("    at "); // no stack frames
  });
  test("other known errors: message only — remediation is already in the message", () => {
    const out = renderFatal(new PreflightError("not authenticated to github.com. Remediate: gh auth login -h github.com"), OPTS);
    expect(out).toBe("orchestrate failed: not authenticated to github.com. Remediate: gh auth login -h github.com\n");
    expect(out).not.toContain("Usage:");
    expect(out).not.toContain("    at ");
  });
  test("unexpected errors keep the full stack", () => {
    const out = renderFatal(new TypeError("undefined is not a function"), OPTS);
    expect(out).toContain("orchestrate failed (unexpected):");
    expect(out).toContain("TypeError: undefined is not a function");
    expect(out).toContain("    at "); // stack frames present
  });
  test("non-Error throw is stringified, not crashed on", () => {
    const out = renderFatal("string throw", { command: "report", usage: "Usage: x" });
    expect(out).toContain("report failed (unexpected):");
    expect(out).toContain("string throw");
  });
});
