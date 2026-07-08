import { expect, test, describe } from "bun:test";
import { scanUnit, makeExcluder, type TreeEntry, type UnitLocation } from "./unitPipeline.ts";
import type { CliTermSet } from "./cliScanner.ts";

const loc: UnitLocation = {
  githubHost: "github.com", organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def",
};

// A synthetic repo as an in-memory file map; readFile serves from it.
function makeIo(files: Record<string, string>): { entries: TreeEntry[]; readFile: (p: string, e: TreeEntry) => Promise<string | null> } {
  const entries: TreeEntry[] = Object.keys(files).map((path) => ({ path, type: "blob", sha: "", size: files[path]!.length }));
  const readFile = async (path: string): Promise<string | null> => files[path] ?? null;
  return { entries, readFile };
}

describe("makeExcluder", () => {
  test("matches configured globs", () => {
    const ex = makeExcluder(["**/dist/**", "**/vendor/**"]);
    expect(ex("a/dist/x.js")).toBe(true);
    expect(ex("src/index.ts")).toBe(false);
  });
});

describe("scanUnit — end to end over a synthetic repo", () => {
  const cfg = { trackedPackages: ["expo"], excludeDirGlobs: ["**/node_modules/**", "**/dist/**"] };
  // specifier + bin terms (bins as introspection would supply them, via eager discovery)
  const terms: CliTermSet[] = [{ packageName: "expo", name: "expo", binNames: ["expo-cli"] }];

  test("dependency finding + import usage + specifier CLI usage for a tracked package", async () => {
    const { entries, readFile } = makeIo({
      "package.json": JSON.stringify({
        name: "svc",
        dependencies: { expo: "^50.0.0" },
        scripts: { start: "expo start", build: "webpack" },
      }),
      "package-lock.json": JSON.stringify({
        name: "svc", lockfileVersion: 3,
        packages: {
          "": { name: "svc", dependencies: { expo: "^50.0.0" } }, // v3 root echoes the manifest deps
          "node_modules/expo": { version: "50.0.7" },
        },
      }),
      "src/index.ts": `import { registerRootComponent } from "expo";\nregisterRootComponent(() => null);`,
      "dist/bundle.js": `import { hidden } from "expo";`, // excluded dir → not scanned
      "deploy.sh": `#!/bin/bash\nexpo-cli export\n`, // bin-term CLI usage (single pass)
    });
    const r = await scanUnit(loc, cfg, entries, readFile, terms);

    // dependency finding: resolved via the npm v3 lockfile
    expect(r.dependencyFindings.length).toBe(1);
    const d = r.dependencyFindings[0]!;
    expect(d.packageName).toBe("expo");
    expect(d.dependencyKey).toBe("expo");
    expect(d.resolvedVersion).toBe("50.0.7");
    expect(d.resolvedVersionSource).toBe("lockfile");
    expect(d.manifestPermalink).toContain("/blob/abc123def/package.json#L");

    // import usage: the named import, attributed to expo; the dist/ file is excluded
    const imports = r.usageFindings.filter((u) => u.usageType === "named-import");
    expect(imports.map((u) => u.exportName)).toEqual(["registerRootComponent"]);
    expect(r.usageFindings.every((u) => u.filePath !== "dist/bundle.js")).toBe(true);

    // CLI usage in ONE pass: specifier `expo start` (scripts.start) + bin `expo-cli` (deploy.sh);
    // webpack in scripts.build is not expo.
    expect(r.cliFindings.map((c) => c.context).sort()).toEqual(["scripts.start", "shell"]);
  });

  test("a no-lockfile repo leaves resolvedVersion null (range resolution is the coordinator's job)", async () => {
    const { entries, readFile } = makeIo({
      "package.json": JSON.stringify({ name: "svc", dependencies: { expo: "^50.0.0" } }),
    });
    const r = await scanUnit(loc, cfg, entries, readFile, terms);
    expect(r.dependencyFindings[0]!.resolvedVersion).toBeNull();
    expect(r.dependencyFindings[0]!.resolvedVersionSource).toBeNull();
    expect(r.dependencyFindings[0]!.resolutionRange).toBe("^50.0.0");
  });

  test("a repo with NO tracked-package declaration yields nothing", async () => {
    const { entries, readFile } = makeIo({
      "package.json": JSON.stringify({ name: "svc", dependencies: { react: "^18" } }),
      "src/index.ts": `import { x } from "react";`,
    });
    const r = await scanUnit(loc, cfg, entries, readFile, terms);
    expect(r.dependencyFindings).toEqual([]);
    expect(r.usageFindings).toEqual([]);
    expect(r.cliFindings).toEqual([]);
  });

  test("a NO-lockfile non-registry DECLARED spec is reported as a scan-time skip (§5.E)", async () => {
    const { entries, readFile } = makeIo({
      "package.json": JSON.stringify({ name: "svc", dependencies: { expo: "github:someuser/expo" } }),
    });
    const r = await scanUnit(loc, cfg, entries, readFile, terms);
    expect(r.dependencyFindings[0]!.resolvedVersion).toBeNull();
    expect(r.nonRegistrySkips).toEqual([{ packageName: "expo", rawSpec: "github:someuser/expo" }]);
  });
  test("a registry range with no lockfile is NOT a non-registry skip", async () => {
    const { entries, readFile } = makeIo({
      "package.json": JSON.stringify({ name: "svc", dependencies: { expo: "^50.0.0" } }),
    });
    const r = await scanUnit(loc, cfg, entries, readFile, terms);
    expect(r.nonRegistrySkips).toEqual([]);
  });
});
