// benchGrammar.test.ts — accept/reject tables for the PROPOSED guard grammars (ADR-0001
// resolution plan §3.2). Mirrors the readOnlyGuard test posture: every rejection is an exact
// structural property of the tuple, not a denylist hit.
import { describe, expect, test } from "bun:test";
import {
  BenchGrammarViolation, assertProposedReadOnlyGit, isFullOid, OID_LENGTH,
  type BenchObjectFormat, type CloneShape,
} from "./benchGrammar.ts";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);
const URL = "https://github.com/o/r.git";

const PROD_CLONE = [
  "clone", "--depth", "1", "--single-branch", "--branch", "main",
  "--no-tags", "--no-recurse-submodules", "--template=", URL, "dest",
];
const NO_CHECKOUT_CLONE = [...PROD_CLONE.slice(0, 9), "--no-checkout", URL, "dest"];

const ok = (args: string[], format: BenchObjectFormat = "sha1", cloneShape?: CloneShape): void =>
  expect(() => assertProposedReadOnlyGit(args, { objectFormat: format, cloneShape })).not.toThrow();
const bad = (args: string[], format: BenchObjectFormat = "sha1", cloneShape?: CloneShape): void =>
  expect(() => assertProposedReadOnlyGit(args, { objectFormat: format, cloneShape })).toThrow(BenchGrammarViolation);

describe("isFullOid", () => {
  test("length is exact per format and hex is lowercase-only", () => {
    expect(isFullOid(SHA1, "sha1")).toBe(true);
    expect(isFullOid(SHA256, "sha256")).toBe(true);
    expect(isFullOid(SHA1, "sha256")).toBe(false); // 40 hex is NOT a sha256 id
    expect(isFullOid(SHA256, "sha1")).toBe(false);
    expect(isFullOid(SHA1.toUpperCase(), "sha1")).toBe(false); // git prints lowercase; pins are lowercase
    expect(isFullOid(SHA1.slice(1), "sha1")).toBe(false);
    expect(isFullOid(`${SHA1.slice(1)}g`, "sha1")).toBe(false);
    expect(OID_LENGTH.sha1).toBe(40);
    expect(OID_LENGTH.sha256).toBe(64);
  });
});

describe("verb surface", () => {
  test("only the four proposed verbs exist; scaffolding verbs are NOT proposed grammar", () => {
    for (const verb of ["init", "remote", "fetch", "checkout", "ls-remote", "show", "log", "--version"])
      bad([verb]);
    bad([]);
  });
  test("a pre-verb global lands in the verb slot and is denied (env carries no-replace instead)", () => {
    bad(["--no-replace-objects", "cat-file", "--batch"]);
    bad(["-c", "core.x=y", "clone", ...PROD_CLONE.slice(1)], "sha1", "checkout");
  });
  test("config-injection short options are denied on every verb, attached forms included", () => {
    bad(["cat-file", "--batch", "-cfoo=bar"]);
    bad(["ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD", "-ufoo"]);
  });
});

describe("cat-file tuple", () => {
  test("exactly `cat-file --batch` and nothing else", () => {
    ok(["cat-file", "--batch"]);
    bad(["cat-file"]);
    bad(["cat-file", "--batch-check"]);
    bad(["cat-file", "--batch", "--textconv"]);
    bad(["cat-file", "--batch", "--filters"]);
    bad(["cat-file", "--batch", SHA1]); // revs come from stdin only — never argv
    bad(["cat-file", "--textconv", "--batch"]);
  });
});

describe("ls-tree tuple", () => {
  const LS = ["ls-tree", "-r", "-z", "-l", "--full-tree"];
  test("exact tuple with HEAD or a full object id in the repo's format", () => {
    ok([...LS, "HEAD"]);
    ok([...LS, SHA1], "sha1");
    ok([...LS, SHA256], "sha256");
    bad([...LS, SHA1], "sha256"); // format mismatch fails closed
    bad([...LS, SHA256], "sha1");
    bad([...LS, "main"]); // a mutable ref would defeat the pinned-SHA discipline
    bad([...LS, "FETCH_HEAD"]); // FETCH_HEAD is a rev-parse-only rev; ls-tree pins the SHA itself
  });
  test("no reorder, no omission, no pathspec, no extras", () => {
    bad(["ls-tree", "-z", "-r", "-l", "--full-tree", "HEAD"]);
    bad(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]); // -l omitted → no canonical sizes
    bad([...LS, "HEAD", "src/"]); // a pathspec narrows the enumeration G2 depends on
    bad([...LS, "HEAD", "--"]);
  });
});

describe("rev-parse tuple", () => {
  test("exactly one rev, HEAD or FETCH_HEAD", () => {
    ok(["rev-parse", "HEAD"]);
    ok(["rev-parse", "FETCH_HEAD"]); // the scaffolding coherence check (a bare fetch leaves no HEAD)
    bad(["rev-parse"]);
    bad(["rev-parse", "main"]);
    bad(["rev-parse", SHA1]);
    bad(["rev-parse", "--git-dir", "HEAD"]);
    bad(["rev-parse", "HEAD", "FETCH_HEAD"]);
  });
});

describe("clone shape 'checkout' (the production tuple)", () => {
  test("the exact production argv passes", () => {
    ok(PROD_CLONE, "sha1", "checkout");
  });
  test("a declared shape is required", () => {
    bad(PROD_CLONE, "sha1", undefined);
  });
  test("--no-checkout cannot join shape 1 (it is a SECOND tuple, not a shared flag)", () => {
    bad(NO_CHECKOUT_CLONE, "sha1", "checkout");
  });
  test("every hardening option is required exactly once", () => {
    for (let i = 0; i < PROD_CLONE.length - 2; i++) {
      const name = PROD_CLONE[i]!;
      if (!name.startsWith("--")) continue;
      const isValue = name === "--depth" || name === "--branch";
      const without = [...PROD_CLONE.slice(0, i), ...PROD_CLONE.slice(i + (isValue ? 2 : 1))];
      bad(without, "sha1", "checkout");
    }
    bad([...PROD_CLONE.slice(0, 9), "--no-tags", URL, "dest"], "sha1", "checkout"); // duplicate
  });
  test("value constraints hold: depth 1, concrete branch, empty template, two positionals", () => {
    bad(PROD_CLONE.map((a, i) => (i === 2 ? "2" : a)), "sha1", "checkout");
    bad(PROD_CLONE.map((a, i) => (i === 5 ? "--no-tags" : a)), "sha1", "checkout"); // flag eaten as branch value
    bad(PROD_CLONE.map((a) => (a === "--template=" ? "--template=x" : a)), "sha1", "checkout");
    bad(PROD_CLONE.slice(0, -1), "sha1", "checkout"); // one positional
    bad([...PROD_CLONE, "extra"], "sha1", "checkout"); // three positionals
  });
  test("bool-with-value, short flags, and unknown options are rejected", () => {
    bad(PROD_CLONE.map((a) => (a === "--single-branch" ? "--single-branch=x" : a)), "sha1", "checkout");
    bad([...PROD_CLONE.slice(0, 9), "-q", URL, "dest"], "sha1", "checkout");
    bad([...PROD_CLONE.slice(0, 9), "--bare", URL, "dest"], "sha1", "checkout");
    bad([...PROD_CLONE.slice(0, 9), "--filter=blob:none", URL, "dest"], "sha1", "checkout");
  });
});

describe("clone shape 'no-checkout' (the second required tuple)", () => {
  test("production argv + --no-checkout passes; --no-checkout is REQUIRED, exactly once", () => {
    ok(NO_CHECKOUT_CLONE, "sha1", "no-checkout");
    bad(PROD_CLONE, "sha1", "no-checkout"); // missing --no-checkout: mandatory in shape 2
    bad([...NO_CHECKOUT_CLONE.slice(0, 10), "--no-checkout", URL, "dest"], "sha1", "no-checkout");
    bad(NO_CHECKOUT_CLONE.map((a) => (a === "--no-checkout" ? "--no-checkout=x" : a)), "sha1", "no-checkout");
  });
  test("the shared hardening requirements carry over unchanged", () => {
    bad(NO_CHECKOUT_CLONE.map((a, i) => (i === 2 ? "0" : a)), "sha1", "no-checkout");
    const withoutTags = NO_CHECKOUT_CLONE.filter((a) => a !== "--no-tags");
    bad(withoutTags, "sha1", "no-checkout");
  });
});
