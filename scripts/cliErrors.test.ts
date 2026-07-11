import { expect, test, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_OPERATOR_ERRORS, isKnownOperatorError, renderFatal } from "./cliErrors.ts";
import { ArgsError, ORCHESTRATE_USAGE } from "./args.ts";
import { PreflightError } from "./preflight.ts";
import { ConfigError } from "./config.ts";
import { ReadOnlyViolation } from "./readOnlyGuard.ts";
import { JsoncError } from "./jsonc.ts";
import { YamlLiteError } from "./yamlLite.ts";
import { EmptyOwnersError } from "./ownerResolve.ts";
import { DbError } from "./db.ts";
import { GithubApiError, ThrottleExhausted } from "./github.ts";
import { IntrospectionError } from "./apiSurface.ts";
import { ArtifactWriteError } from "./artifactWrite.ts";

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

describe("KNOWN_OPERATOR_ERRORS registry sync (name-string matching must never drift)", () => {
  test("a REAL instance of every registered class is recognized, and the names cover the registry exactly", () => {
    // one live instance per registered class — a typo'd `this.name` in any constructor fails here
    const instances: Error[] = [
      new ArgsError("x"), new ConfigError("x"), new JsoncError("x", 1), new YamlLiteError("x", 1),
      new PreflightError("x"), new EmptyOwnersError("x"), new DbError("x"),
      new GithubApiError("x"), new ThrottleExhausted("graphql"),
      new IntrospectionError("x"), new ReadOnlyViolation("READ-ONLY VIOLATION: x"),
      new ArtifactWriteError("x"),
    ];
    expect(new Set(instances.map((e) => e.name))).toEqual(new Set(KNOWN_OPERATOR_ERRORS));
    for (const e of instances) expect(isKnownOperatorError(e)).toBe(true);
  });

  test("every exported Error subclass in scripts/ is registered or explicitly excluded (source scan)", () => {
    // A NEW operator-facing error class must either join the registry (clean message, no stack)
    // or this exclusion list (deliberate decision, with the stack-dump consequence on record).
    // Naming constraint the regex relies on: error base classes must be named `Error` or `*Error`
    // (all 11 current classes extend Error directly).
    const EXCLUDED_NON_OPERATOR_ERRORS = new Set<string>([]);
    const declared = new Set<string>();
    for (const file of readdirSync(import.meta.dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      for (const m of src.matchAll(/export class (\w+) extends \w*Error\b/g)) declared.add(m[1]!);
    }
    expect(declared.size).toBeGreaterThan(0); // the scan itself works
    const unregistered = [...declared].filter((n) => !KNOWN_OPERATOR_ERRORS.has(n) && !EXCLUDED_NON_OPERATOR_ERRORS.has(n)).sort();
    expect(unregistered).toEqual([]);
    const stale = [...KNOWN_OPERATOR_ERRORS].filter((n) => !declared.has(n)).sort();
    expect(stale).toEqual([]);
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
  test("ThrottleExhausted carries wait/re-run remediation in its message, NO stack", () => {
    // §4: exhaustion means the wrapper already waited through its retry budget — the operator's
    // remediation is time, not configuration, and resume semantics make a re-run cheap.
    const out = renderFatal(new ThrottleExhausted("graphql"), OPTS);
    expect(out).toContain("orchestrate failed: ");
    expect(out).toContain("graphql");
    expect(out.toLowerCase()).toContain("wait");
    expect(out.toLowerCase()).toContain("re-run");
    expect(out).not.toContain("    at "); // no stack frames
  });
});
