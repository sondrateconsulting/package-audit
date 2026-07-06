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
    ["--version"],
  ];
  for (const args of good) test(args.join(" "), () => ok(() => assertReadOnlyGh(args)));
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
  test("--version passes", () => ok(() => assertReadOnlyGit(["--version"])));
  test("push throws", () => throws(() => assertReadOnlyGit(["push"])));
  test("clone -c injection throws", () =>
    throws(() => assertReadOnlyGit(sh("clone -c core.fsmonitor=x --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone -cfoo=baz throws", () =>
    throws(() => assertReadOnlyGit(sh("clone -cfoo=baz --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone -ufoo throws", () =>
    throws(() => assertReadOnlyGit(sh("clone -ufoo --depth 1 --single-branch --branch m --no-tags --no-recurse-submodules --template= u d"))));
  test("clone missing hardening throws", () => throws(() => assertReadOnlyGit(["clone", "url", "dir"])));
  test("show verb rejected (has --output write vector)", () => throws(() => assertReadOnlyGit(["show", "HEAD"])));
  test("cat-file verb rejected", () => throws(() => assertReadOnlyGit(["cat-file", "-p", "HEAD"])));
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
