import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReadOnlyGh,
  assertReadOnlyGit,
  assertReadOnlyTar,
  assertSpawnAllowed,
  assertContained,
  ReadOnlyViolation,
} from "./readOnlyGuard.ts";

const sh = (s: string): string[] => s.split(" ").filter(Boolean);
const throws = (fn: () => void) => expect(fn).toThrow(ReadOnlyViolation);
const ok = (fn: () => void) => expect(fn).not.toThrow();

describe("assertReadOnlyGh — spec THROW vectors", () => {
  const bad = [
    ["api", "-X", "DELETE", "repos/o/r/issues"],
    ["api", "-XDELETE", "repos/o/r/issues"],
    ["api", "-X", "GET", "-X", "DELETE", "repos/o/r/issues"], // later value wins
    ["api", "--method=DELETE", "repos/o/r/issues"],
    ["api", "repos/o/r/issues", "-f", "title=x"],
    ["api", "repos/o/r/issues", "-fbody=x"],
    ["api", "repos/o/r/issues", "--field=title=x"],
    ["api", "graphql", "-f", "query=mutation{x}"],
    ["api", "graphql", "-f", "query=fragment F on T{a} mutation{x}"],
    ["api", "graphql", "--input", "body.json"],
  ];
  for (const args of bad) test(args.join(" "), () => throws(() => assertReadOnlyGh(args)));
});

describe("assertReadOnlyGh — spec PASS vectors (tool's own reads)", () => {
  const good = [
    ["api", "-i", "user/orgs?per_page=100&page=1"],
    ["api", "-i", "user"],
    ["api", "-i", "orgs/o/repos?per_page=100&page=1&type=all"],
    ["api", "-i", "user/repos?affiliation=owner&per_page=100&page=1"],
    ["api", "repos/o/r/contents/p?ref=sha", "--jq", ".content"],
    ["api", "repos/o/r/git/blobs/sha"],
    ["api", "repos/o/r/git/trees/treeoid?recursive=1"],
    ["api", "graphql", "-f", "query=query{viewer{login}}"],
    ["api", "rate_limit"],
    ["repo", "list"],
    ["auth", "status"],
    ["auth", "status", "--hostname", "github.com"], // the sole permitted trailing form
    ["--version"],
  ];
  for (const args of good) test(args.join(" "), () => ok(() => assertReadOnlyGh(args)));
});

describe("assertReadOnlyGh — token-disclosure / host-override hardening", () => {
  test("gh auth status --show-token is rejected (§2: never print tokens)", () =>
    throws(() => assertReadOnlyGh(["auth", "status", "--show-token"])));
  test("gh auth status -t is rejected", () => throws(() => assertReadOnlyGh(["auth", "status", "-t"])));
  test("gh api --hostname <other> is rejected (overrides the GH_HOST pin)", () =>
    throws(() => assertReadOnlyGh(["api", "--hostname", "evil.example", "user"])));
  test("gh api --hostname=<other> is rejected", () =>
    throws(() => assertReadOnlyGh(["api", "--hostname=evil.example", "user"])));
  test("gh auth status --hostname --show-token (flag-as-value) is rejected", () =>
    throws(() => assertReadOnlyGh(["auth", "status", "--hostname", "--show-token"])));
  test("gh auth status --hostname with no value is rejected", () =>
    throws(() => assertReadOnlyGh(["auth", "status", "--hostname"])));
  test("gh auth status --hostname host --show-token (extra trailing) is rejected", () =>
    throws(() => assertReadOnlyGh(["auth", "status", "--hostname", "github.com", "--show-token"])));
  test("gh auth status --hostname=host (attached form) is rejected — tool only emits the separate form", () =>
    throws(() => assertReadOnlyGh(["auth", "status", "--hostname=github.com"])));
});

describe("assertReadOnlyGh — organizations pagination endpoint (§5.A)", () => {
  // GitHub Link rel="next" URLs canonicalize `orgs/<login>/repos` to the numeric
  // `organizations/<id>/repos` form — ONLY that exact shape may pass.
  test("numeric organizations/<id>/repos pagination endpoint passes", () =>
    ok(() => assertReadOnlyGh(["api", "-i", "organizations/143746735/repos?per_page=100&page=2&type=all"])));
  test("query-less organizations/<id>/repos passes (a Link URL may carry no query)", () =>
    ok(() => assertReadOnlyGh(["api", "-i", "organizations/143746735/repos"])));
  test("non-numeric org id is rejected", () =>
    throws(() => assertReadOnlyGh(["api", "-i", "organizations/wftgitsas/repos?per_page=100&page=2&type=all"])));
  test("mixed alphanumeric org id is rejected", () =>
    throws(() => assertReadOnlyGh(["api", "-i", "organizations/143746735x/repos"])));
  test("a non-repos organizations resource is rejected", () =>
    throws(() => assertReadOnlyGh(["api", "-i", "organizations/143746735/members"])));
  test("extra segments after repos are rejected", () =>
    throws(() => assertReadOnlyGh(["api", "-i", "organizations/143746735/repos/extra"])));
  test("bare organizations is rejected", () => throws(() => assertReadOnlyGh(["api", "organizations"])));
  test("organizations/<id> without repos is rejected", () =>
    throws(() => assertReadOnlyGh(["api", "organizations/143746735"])));
  test("empty org id is rejected", () => throws(() => assertReadOnlyGh(["api", "organizations//repos"])));
  test("a trailing slash is rejected (exact shape only)", () =>
    throws(() => assertReadOnlyGh(["api", "organizations/143746735/repos/"])));
  // pins the LEADING regex anchor: a suffix-only match must not allow a nested decoy path.
  test("a nested decoy prefix is rejected", () =>
    throws(() => assertReadOnlyGh(["api", "organizations/9/x/organizations/123/repos"])));
});

describe("assertReadOnlyGh — extra bypass vectors", () => {
  test("short cluster -iXDELETE is rejected", () => throws(() => assertReadOnlyGh(["api", "-iXDELETE", "repos/o/r"])));
  test("non-allowlisted endpoint reposXYZ", () => throws(() => assertReadOnlyGh(["api", "reposXYZ/o/r"])));
  test("path traversal user/../orgs", () => throws(() => assertReadOnlyGh(["api", "user/../orgs"])));
  test("encoded slash %2f", () => throws(() => assertReadOnlyGh(["api", "repos%2f..%2fadmin"])));
  test("gh auth refresh is rejected", () => throws(() => assertReadOnlyGh(["auth", "refresh"])));
  test("graphql with two query bodies", () =>
    throws(() => assertReadOnlyGh(["api", "graphql", "-f", "query=query{a}", "-f", "query=mutation{b}"])));
  test("graphql mutation hidden in a string is allowed", () =>
    ok(() => assertReadOnlyGh(["api", "graphql", "-f", 'query=query{f(x:"mutation")}'])));
  // GraphQL commas are ignored whitespace: a comma-separated mutation must NOT slip past.
  test("graphql comma-separated mutation", () =>
    throws(() => assertReadOnlyGh(["api", "graphql", "-f", "query=query{a},mutation{b}"])));
  test("graphql comma fragment-then-mutation", () =>
    throws(() => assertReadOnlyGh(["api", "graphql", "-f", "query=fragment F on T{a},mutation{x}"])));
  test("graphql subscription", () =>
    throws(() => assertReadOnlyGh(["api", "graphql", "-f", "query=subscription{onX{y}}"])));
  test("gh api --cache throws (writes cache outside contained roots)", () =>
    throws(() => assertReadOnlyGh(["api", "--cache", "1h", "repos/o/r"])));
  test("gh api --cache=1h throws", () => throws(() => assertReadOnlyGh(["api", "--cache=1h", "repos/o/r"])));
  test("gh api with no endpoint", () => throws(() => assertReadOnlyGh(["api", "-i"])));
  test("empty args", () => throws(() => assertReadOnlyGh([])));
});

describe("assertReadOnlyGit", () => {
  const HARDENED = sh(
    "clone --depth 1 --single-branch --branch main --no-tags --no-recurse-submodules --template= https://github.com/o/r /tmp/pkg-audit-x",
  );
  test("hardened clone passes", () => ok(() => assertReadOnlyGit(HARDENED)));
  test("rev-parse HEAD passes", () => ok(() => assertReadOnlyGit(["rev-parse", "HEAD"])));
  // exact tuple, like show/ls-tree/cat-file — the tool emits no other rev-parse form
  test("bare rev-parse throws", () => throws(() => assertReadOnlyGit(["rev-parse"])));
  test("rev-parse of a branch name throws", () => throws(() => assertReadOnlyGit(["rev-parse", "main"])));
  test("rev-parse with an extra rev throws", () => throws(() => assertReadOnlyGit(["rev-parse", "HEAD", "OTHER"])));
  test("--version passes", () => ok(() => assertReadOnlyGit(["--version"])));
  test("push throws", () => throws(() => assertReadOnlyGit(["push"])));
  test("clone -c injection throws", () =>
    throws(() => assertReadOnlyGit(sh("clone -c core.fsmonitor=x --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone -cfoo=baz throws", () =>
    throws(() => assertReadOnlyGit(sh("clone -cfoo=baz --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone -ufoo throws", () =>
    throws(() => assertReadOnlyGit(sh("clone -ufoo --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone missing hardening throws", () => throws(() => assertReadOnlyGit(["clone", "url", "dir"])));
  // `show` is EXCLUDED again since the T2c cutover (its only caller — the checkout fallback's
  // commit-date read — retired with the fallback): even its once-permitted exact tuple denies.
  const SHOW_DATE = ["show", "--no-patch", "--no-notes", "--no-show-signature", "--format=%cI", "HEAD"];
  test("show is excluded entirely — even the once-permitted commit-date tuple denies", () => throws(() => assertReadOnlyGit(SHOW_DATE)));
  test("bare `show HEAD` rejected", () => throws(() => assertReadOnlyGit(["show", "HEAD"])));
  test("git -C before a show tuple rejected (pre-verb global)", () => throws(() => assertReadOnlyGit(["-C", "/other", ...SHOW_DATE])));
  test("cat-file outside the exact batch tuple rejected (-p form)", () => throws(() => assertReadOnlyGit(["cat-file", "-p", "HEAD"])));
  test("clone non-empty --template override throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template=/tmp/evil u d"))));
  test("clone --separate-git-dir throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --separate-git-dir=/tmp/x u d"))));
  test("clone positive --recurse-submodules throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --recurse-submodules --template= u d"))));
  test("clone abbreviated --separate-git throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --separate-git=/tmp/x u d"))));
  test("clone duplicate non-empty --template throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --template=/tmp/evil u d"))));
  test("clone --recursive alias throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --recursive --template= u d"))));
  test("clone --output throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --output=/tmp/x --template= u d"))));
  test("clone abbreviated --templ=/tmp/evil throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --templ=/tmp/evil u d"))));
  test("clone abbreviated --dep= throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --dep=1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone --mirror throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --mirror --template= u d"))));
  test("clone --bare throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --bare --template= u d"))));
  test("pre-verb global -c throws", () => throws(() => assertReadOnlyGit(sh("-c core.x=y clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("rev-parse --git-dir option throws", () => throws(() => assertReadOnlyGit(["rev-parse", "--git-dir"])));
  test("clone missing --branch throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --no-tags --no-recurse-submodules --template= u d"))));
  test("clone --depth not 1 throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 999999 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone duplicate --depth override throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --depth 999999 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("git --version with -c throws", () => throws(() => assertReadOnlyGit(sh("--version -c core.fsmonitor=x"))));
  test("git --version sole passes", () => ok(() => assertReadOnlyGit(["--version"])));
  // arity attack: --branch swallows --template= as its value, leaving --template unset.
  test("clone --branch swallows --template= throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch --template= --no-tags --no-recurse-submodules u d"))));
  test("clone empty --branch value throws", () =>
    throws(() => assertReadOnlyGit(["clone", "--depth", "1", "--single-branch", "--branch", "", "--no-tags", "--no-recurse-submodules", "--template=", "u", "d"])));
  test("clone with 3 positionals throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d extra"))));
  test("clone bool flag given a value (--single-branch=x) throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch=x --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone --depth=1 attached form passes", () =>
    ok(() => assertReadOnlyGit(sh("clone --depth=1 --single-branch --branch=m --no-tags --no-recurse-submodules --template= u d"))));
  test("empty args", () => throws(() => assertReadOnlyGit([])));
});

// ---- ADR-0001 T2c grammars (accept/reject tables — Confirmation check 1) --------------------
// Exactness-discipline note (santa round-1 adjudication): ls-tree/cat-file (like `show`) are
// compared as RAW TUPLES, while BOTH clone shapes are PARSED grammars — order-free, attached
// value forms allowed, every option mandatory-exactly-once. That split is the governing
// bill's own definition: the ADR specifies the "second exact clone shape" BY the
// mandatory-exactly-once discipline of this guard's existing clone parser (ADR-0001 Option
// 2c cons; resolution plan §3.2(i)), and the pre-T2c clone grammar always accepted
// attached/reordered forms.
describe("assertReadOnlyGit — the no-checkout clone tuple (second exact shape)", () => {
  // The canonical shape-2 argv with each flag's token span, for table-driven mutations.
  const NC_ARGV = ["clone", "--depth", "1", "--single-branch", "--branch", "main", "--no-tags", "--no-recurse-submodules", "--template=", "--no-checkout", "https://github.com/o/r", "/tmp/pkg-audit-x"];
  const NC_SPAN: Record<string, readonly [number, number]> = {
    "--depth": [1, 2], "--single-branch": [3, 1], "--branch": [4, 2], "--no-tags": [6, 1],
    "--no-recurse-submodules": [7, 1], "--template": [8, 1], "--no-checkout": [9, 1],
  };
  for (const [flag, [at, len]] of Object.entries(NC_SPAN)) {
    // omitting --no-checkout itself yields the (accepted) first shape — covered by the
    // shape-1 accept vector below, so the omission table spans the six SHARED flags only.
    if (flag !== "--no-checkout")
      test(`shape-2 omission of ${flag} throws`, () =>
        throws(() => assertReadOnlyGit([...NC_ARGV.slice(0, at), ...NC_ARGV.slice(at + len)])));
    test(`shape-2 duplication of ${flag} throws`, () =>
      throws(() => assertReadOnlyGit([...NC_ARGV.slice(0, at), ...NC_ARGV.slice(at, at + len), ...NC_ARGV.slice(at)])));
  }
  for (const boolFlag of ["--single-branch", "--no-tags", "--no-recurse-submodules", "--no-checkout"])
    test(`shape-2 ${boolFlag} given a value throws (bool flags stay bare)`, () =>
      throws(() => assertReadOnlyGit(NC_ARGV.map((a) => (a === boolFlag ? `${boolFlag}=x` : a)))));
  // arity: a DETACHED value flag in the terminal slot has no value token. `--template` is the
  // exploitable one — its required value IS the empty string, so folding "missing" to "" let a
  // bare terminal --template satisfy the hardening (santa round-2). Both shapes are pinned.
  for (const valueFlag of ["--template", "--depth", "--branch"]) {
    test(`shape-2 terminal bare ${valueFlag} throws (missing value is not an empty value)`, () =>
      throws(() => assertReadOnlyGit([...NC_ARGV.filter((a) => !a.startsWith(valueFlag)), valueFlag])));
    test(`shape-1 terminal bare ${valueFlag} throws`, () =>
      throws(() => assertReadOnlyGit([...NC_ARGV.filter((a) => a !== "--no-checkout" && !a.startsWith(valueFlag)), valueFlag])));
  }
  test("shape-2 with a third positional throws", () =>
    throws(() => assertReadOnlyGit([...NC_ARGV, "extra"])));
  test("shape-2 with one positional throws", () =>
    throws(() => assertReadOnlyGit(NC_ARGV.slice(0, -1))));
  const NC = sh(
    "clone --depth 1 --single-branch --branch main --no-tags --no-recurse-submodules --template= --no-checkout https://github.com/o/r /tmp/pkg-audit-x",
  );
  test("the exact no-checkout tuple passes", () => ok(() => assertReadOnlyGit(NC)));
  test("flag order is free within the tuple (--no-checkout first)", () =>
    ok(() => assertReadOnlyGit(sh("clone --no-checkout --depth 1 --single-branch --branch main --no-tags --no-recurse-submodules --template= u d"))));
  test("attached value forms still pass with --no-checkout", () =>
    ok(() => assertReadOnlyGit(sh("clone --depth=1 --single-branch --branch=m --no-tags --no-recurse-submodules --template= --no-checkout u d"))));
  test("duplicate --no-checkout throws (mandatory-exactly-once)", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --no-checkout --no-checkout u d"))));
  test("--no-checkout given a value throws (bool flag)", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --no-checkout=x u d"))));
  test("--no-checkout without the rest of the hardening throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --no-checkout u d"))));
  test("--no-checkout with one hardening flag missing throws (no shape mixing)", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-recurse-submodules --template= --no-checkout u d"))));
  test("abbreviated --no-checkou throws", () =>
    throws(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --no-checkou u d"))));
  test("-c injection alongside --no-checkout still throws", () =>
    throws(() => assertReadOnlyGit(sh("clone -c core.fsmonitor=x --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= --no-checkout u d"))));
  test("the checkout tuple (shape 1) still passes beside shape 2", () =>
    ok(() => assertReadOnlyGit(sh("clone --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
});

describe("assertReadOnlyGit — the ls-tree tuple", () => {
  const LS = ["ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD"];
  test("the exact tuple passes", () => ok(() => assertReadOnlyGit(LS)));
  // per-slot mutation tables over the inner tokens (the verb and rev have their own vectors)
  for (let i = 1; i < LS.length - 1; i++) {
    test(`omitting ${LS[i]} throws`, () => throws(() => assertReadOnlyGit(LS.filter((_, j) => j !== i))));
    test(`duplicating ${LS[i]} throws`, () =>
      throws(() => assertReadOnlyGit([...LS.slice(0, i), LS[i]!, ...LS.slice(i)])));
  }
  test("abbreviated --full-tre throws", () => throws(() => assertReadOnlyGit(["ls-tree", "-r", "-z", "-l", "--full-tre", "HEAD"])));
  test("omitting the HEAD rev throws", () => throws(() => assertReadOnlyGit(LS.slice(0, 5))));
  test("duplicating the HEAD rev throws", () => throws(() => assertReadOnlyGit([...LS, "HEAD"])));
  test("a SPARSE argv with holes in mandatory slots throws (santa round-1: hole-skipping iteration bypass)", () => {
    const sparse = new Array(6) as string[];
    sparse[0] = "ls-tree";
    sparse[5] = "HEAD";
    throws(() => assertReadOnlyGit(sparse));
  });
  test("a DENSE argv with an overridden `every` throws (santa round-3: method-override bypass)", () => {
    // Own string slots spelling a WRITE-capable `show --output=...`, with the tuple sweep
    // rigged to report agreement. The guard must compare its own copy, never the caller's.
    const danger = ["show", "--no-patch", "--no-notes", "--no-show-signature", "--output=/tmp/pwned", "HEAD"];
    const rigged = Object.create(Array.prototype) as Record<string, unknown>;
    rigged["every"] = () => true;
    Object.setPrototypeOf(danger, rigged);
    throws(() => assertReadOnlyGit(danger));
  });
  test("a DENSE argv with an overridden `flatMap` throws (canonicalization must run on our copy)", () => {
    const danger = ["clone", "--upload-pack", "/tmp/pwned", "u", "d"];
    const rigged = Object.create(Array.prototype) as Record<string, unknown>;
    rigged["flatMap"] = () => ["--version"]; // pretend to canon into a harmless argv
    Object.setPrototypeOf(danger, rigged);
    throws(() => assertReadOnlyGit(danger));
  });
  test("an ARRAY-LIKE argv with a lying `length` getter throws (validated argv must equal the spawned one)", () => {
    // A real Array's length is non-configurable, so this attack needs an array-like: it would
    // report 2 slots to the guard while carrying a third (`--textconv`) into the spawn. The
    // guard therefore requires a genuine Array.
    const danger = { 0: "cat-file", 1: "--batch", 2: "--textconv", get length() { return 2; } };
    throws(() => assertReadOnlyGit(danger as unknown as string[]));
  });
  test("a non-array argv throws", () => throws(() => assertReadOnlyGit("clone" as unknown as string[])));
  test("a PROTOTYPE-BACKED sparse argv throws (santa round-2: holes read through the prototype)", () => {
    // holes serve conforming tokens via a prototype trap while iteration helpers still skip
    // them — value checks and iteration disagree unless own-ness is required.
    const proto = new Proxy(Array.prototype, {
      get(target, key, receiver) {
        const n = Number(key);
        if (Number.isInteger(n)) return LS[n];
        return Reflect.get(target, key, receiver);
      },
    });
    const argv = ["ls-tree", "", "", "", "", "HEAD"] as string[];
    for (const i of [1, 2, 3, 4]) delete argv[i];
    Object.setPrototypeOf(argv, proto);
    throws(() => assertReadOnlyGit(argv));
  });
  test("reordered flags throw", () => throws(() => assertReadOnlyGit(["ls-tree", "-z", "-r", "-l", "--full-tree", "HEAD"])));
  test("missing -l throws", () => throws(() => assertReadOnlyGit(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])));
  test("a branch-name rev throws (HEAD only)", () => throws(() => assertReadOnlyGit(["ls-tree", "-r", "-z", "-l", "--full-tree", "main"])));
  test("a full-oid rev throws (production pins HEAD after the coherence gate)", () =>
    throws(() => assertReadOnlyGit(["ls-tree", "-r", "-z", "-l", "--full-tree", "a".repeat(40)])));
  test("a trailing pathspec throws (it would silently narrow enumeration)", () =>
    throws(() => assertReadOnlyGit([...LS, "src/"])));
  test("bare ls-tree HEAD throws", () => throws(() => assertReadOnlyGit(["ls-tree", "HEAD"])));
  test("attached --full-tree=x throws", () => throws(() => assertReadOnlyGit(["ls-tree", "-r", "-z", "-l", "--full-tree=x", "HEAD"])));
  test("-c injection on ls-tree throws", () => throws(() => assertReadOnlyGit(["ls-tree", "-c", "x=y", "-r", "-z", "-l", "--full-tree", "HEAD"])));
  test("pre-verb global before ls-tree throws", () => throws(() => assertReadOnlyGit(["-c", "x=y", "ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD"])));
});

describe("assertReadOnlyGit — the cat-file batch tuple (structural absence of every option)", () => {
  test("the exact two-token tuple passes", () => ok(() => assertReadOnlyGit(["cat-file", "--batch"])));
  test("--textconv appended throws", () => throws(() => assertReadOnlyGit(["cat-file", "--batch", "--textconv"])));
  test("--textconv before --batch throws", () => throws(() => assertReadOnlyGit(["cat-file", "--textconv", "--batch"])));
  test("--filters appended throws", () => throws(() => assertReadOnlyGit(["cat-file", "--batch", "--filters"])));
  test("--batch-check throws (a different tuple)", () => throws(() => assertReadOnlyGit(["cat-file", "--batch-check"])));
  test("-z appended throws", () => throws(() => assertReadOnlyGit(["cat-file", "--batch", "-z"])));
  test("a rev argument throws (revs travel on stdin, contained by the writer)", () =>
    throws(() => assertReadOnlyGit(["cat-file", "--batch", "HEAD"])));
  test("attached --batch=x throws", () => throws(() => assertReadOnlyGit(["cat-file", "--batch=x"])));
  test("bare cat-file throws", () => throws(() => assertReadOnlyGit(["cat-file"])));
  test("-c injection on cat-file throws", () => throws(() => assertReadOnlyGit(["cat-file", "-c", "x=y", "--batch"])));
  test("duplicate --batch throws", () => throws(() => assertReadOnlyGit(["cat-file", "--batch", "--batch"])));
  test("abbreviated --batc throws", () => throws(() => assertReadOnlyGit(["cat-file", "--batc"])));
  test("pre-verb global before cat-file throws", () => throws(() => assertReadOnlyGit(["-c", "x=y", "cat-file", "--batch"])));
});

describe("assertReadOnlyTar", () => {
  test("-xzf -C passes", () => ok(() => assertReadOnlyTar(sh("-xzf f.tgz -C dir"))));
  test("-tzf passes", () => ok(() => assertReadOnlyTar(sh("-tzf f.tgz"))));
  test("--version sole passes", () => ok(() => assertReadOnlyTar(["--version"])));
  test("-cf throws", () => throws(() => assertReadOnlyTar(sh("-cf out.tar dir"))));
  test("--create throws", () => throws(() => assertReadOnlyTar(sh("--create -f out.tar dir"))));
  test("checkpoint exec throws", () => throws(() => assertReadOnlyTar(sh("-xzf f.tgz --checkpoint-action=exec=sh"))));
  test("use-compress-program throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --use-compress-program=sh"))));
  // GNU tar accepts unambiguous long-option abbreviations — every one must be rejected.
  test("abbrev --use=sh throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --use=sh"))));
  test("abbrev --use-compress-progra=sh throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --use-compress-progra=sh"))));
  test("abbrev --to-comman=sh throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --to-comman=sh"))));
  test("abbrev --rmt-comman=sh throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --rmt-comman=sh"))));
  test("abbrev --info-scrip=sh throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --info-scrip=sh"))));
  test("abbrev --absolute-name throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --absolute-name"))));
  test("abbrev --listed-incrementa= throws", () => throws(() => assertReadOnlyTar(sh("-xf f.tar --listed-incrementa=snap"))));
  test("abbrev --creat throws", () => throws(() => assertReadOnlyTar(sh("--creat -f o.tar d"))));
  test("-I cluster throws", () => throws(() => assertReadOnlyTar(sh("-xIsh f.tar"))));
  test("-P absolute-names throws", () => throws(() => assertReadOnlyTar(sh("-xPf f.tar"))));
  test("-g incremental throws", () => throws(() => assertReadOnlyTar(sh("-xgf snap f.tar"))));
  test("extract with --no-same-owner/permissions passes", () =>
    ok(() => assertReadOnlyTar(sh("-xzf f.tgz -C dir --no-same-owner --no-same-permissions"))));
  test("--version with extra args throws", () => throws(() => assertReadOnlyTar(sh("--version --create -f o.tar d"))));
  test("empty args", () => throws(() => assertReadOnlyTar([])));
});

describe("assertSpawnAllowed", () => {
  for (const pm of ["npm", "npx", "yarn", "pnpm", "bunx", "corepack"])
    test(`${pm} banned`, () => throws(() => assertSpawnAllowed(pm)));
  test("/usr/bin/npm banned by basename", () => throws(() => assertSpawnAllowed("/usr/bin/npm")));
  test("npm.cmd banned", () => throws(() => assertSpawnAllowed("npm.cmd")));
  test("bun x banned", () => throws(() => assertSpawnAllowed("bun", ["x", "cowsay"])));
  test("bun install banned", () => throws(() => assertSpawnAllowed("bun", ["install"])));
  test("bun --cwd d add banned", () => throws(() => assertSpawnAllowed("bun", ["--cwd", "d", "add", "x"])));
  test("bun run evil.ts banned (not tool's own script)", () => throws(() => assertSpawnAllowed("bun", ["run", "evil.ts"])));
  test("bun run /repo/build.ts banned", () => throws(() => assertSpawnAllowed("bun", ["run", "/repo/build.ts"])));
  test("bun --cwd repo run build banned", () => throws(() => assertSpawnAllowed("bun", ["--cwd", "repo", "run", "build"])));
  test("bun --eval before script banned", () => throws(() => assertSpawnAllowed("bun", ["--eval=console.log(1)", "scripts/report.ts"])));
  test("bun --preload before script banned", () => throws(() => assertSpawnAllowed("bun", ["--preload=evil.ts", "scripts/report.ts"])));
  test("bun run --eval banned", () => throws(() => assertSpawnAllowed("bun", ["run", "--eval=x", "scripts/report.ts"])));
  test("bun run scripts/orchestrate.ts --flag (script args) allowed", () => ok(() => assertSpawnAllowed("bun", ["run", "scripts/orchestrate.ts", "--fresh"])));
  test("bun run scripts/orchestrate.ts allowed", () => ok(() => assertSpawnAllowed("bun", ["run", "scripts/orchestrate.ts"])));
  test("bun scripts/report.ts (implicit run) allowed", () => ok(() => assertSpawnAllowed("bun", ["scripts/report.ts"])));
  test("git allowed at spawn layer", () => ok(() => assertSpawnAllowed("git", ["rev-parse"])));
});

describe("assertContained (write containment §0)", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pkg-audit-test-root-"));
    outside = mkdtempSync(join(tmpdir(), "pkg-audit-test-outside-"));
    mkdirSync(join(root, "sub"), { recursive: true });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("a path inside the root passes", () => ok(() => assertContained(join(root, "sub", "audit.db"), [root])));
  test("the root itself passes", () => ok(() => assertContained(root, [root])));
  test("a not-yet-created file under the root passes", () => ok(() => assertContained(join(root, "new", "deep", "x.json"), [root])));
  test("a path outside the root throws", () => throws(() => assertContained(join(outside, "evil.db"), [root])));
  test("a .. traversal escaping the root throws", () => throws(() => assertContained(join(root, "..", "evil.db"), [root])));
  test("a sibling-prefix path (root + suffix) throws", () => throws(() => assertContained(root + "-evil", [root])));
  test("no allowed roots throws", () => throws(() => assertContained(join(root, "x"), [])));
  test("a symlink escaping the root throws", () => {
    const link = join(root, "escape");
    symlinkSync(outside, link);
    // realpath resolves `escape` -> outside, which is not under root.
    throws(() => assertContained(join(link, "evil.db"), [root]));
  });
  test("a DANGLING symlink tail (target not yet created) still throws", () => {
    // an existing symlink pointing OUTSIDE to a not-yet-created target: a write through it
    // would land outside the root, so containment must reject it (regression: realpathSync
    // would have thrown on the dangling link and mistaken it for a plain tail).
    const link = join(root, "dangling");
    symlinkSync(join(outside, "will-be-created"), link);
    throws(() => assertContained(join(link, "cloned.txt"), [root]));
  });
  test("a symlink to a not-yet-created target INSIDE the root passes", () => {
    const link = join(root, "inward");
    symlinkSync(join(root, "sub", "future"), link);
    ok(() => assertContained(join(link, "audit.db"), [root]));
  });
  test("a symlink loop fails closed", () => {
    const a = join(root, "loopA");
    const b = join(root, "loopB");
    symlinkSync(b, a);
    symlinkSync(a, b);
    throws(() => assertContained(join(a, "x"), [root]));
  });
  test("'..' AFTER a symlink escapes (must not lexically pre-collapse)", () => {
    // <root>/outLink -> <outside>/subdir ; target <root>/outLink/../evil.db resolves in the
    // filesystem to <outside>/evil.db, NOT <root>/evil.db. A lexical resolve() would collapse
    // outLink/.. first and wrongly report containment.
    mkdirSync(join(outside, "subdir"), { recursive: true });
    const link = join(root, "outLink");
    symlinkSync(join(outside, "subdir"), link);
    // build the path RAW (join() would lexically collapse outLink/.. before we test it)
    const rawTarget = `${root}/outLink/../evil.db`;
    expect(rawTarget).toContain("/../"); // invariant: a future join() refactor must not neuter this
    throws(() => assertContained(rawTarget, [root]));
  });
  test("in-root '..' still passes", () =>
    ok(() => assertContained(`${root}/sub/../audit.db`, [root])));
  test("relative symlink target escaping the root throws", () => {
    // root and outside share a temp parent, so a RELATIVE target `../<outside-base>` resolved
    // against the link's dir (root) reaches outside.
    const link = join(root, "relLink");
    symlinkSync(join("..", outside.split("/").pop()!), link);
    throws(() => assertContained(join(link, "evil.db"), [root]));
  });
});
