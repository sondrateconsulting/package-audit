import { expect, test, describe } from "bun:test";
import {
  parseAlias, extractDependencyFacts, installNameSet, locateManifests, nearestLockfile,
  resolveOwningManifest, dirOf, baseOf, type DependencyFact,
} from "./manifest.ts";

describe("parseAlias", () => {
  test("parses npm alias with scoped and unscoped names", () => {
    expect(parseAlias("npm:expo@^50.0.0")).toEqual({ name: "expo", range: "^50.0.0" });
    expect(parseAlias("npm:@scope/pkg@~2.0.0")).toEqual({ name: "@scope/pkg", range: "~2.0.0" });
    expect(parseAlias("npm:expo")).toEqual({ name: "expo", range: "" });
  });
  test("non-alias values return null", () => {
    expect(parseAlias("^1.2.3")).toBeNull();
    expect(parseAlias("workspace:*")).toBeNull();
    expect(parseAlias("git+https://x")).toBeNull();
  });
});

describe("extractDependencyFacts — §5.D", () => {
  test("direct install under the registry name in each section", () => {
    const text = `{
  "dependencies": { "expo": "^50.0.0" },
  "devDependencies": { "expo": "^50.0.0" }
}`;
    const facts = extractDependencyFacts(text, ["expo"]);
    expect(facts.length).toBe(2);
    expect(facts.map((f) => f.dependencyType).sort()).toEqual(["dependencies", "devDependencies"]);
    expect(facts[0]).toMatchObject({ packageName: "expo", dependencyKey: "expo", isAlias: false, manifestLine: 2 });
  });
  test("alias install: value npm:<tracked>@range under any key is a finding", () => {
    const text = `{ "dependencies": { "my-expo": "npm:expo@^50.0.0" } }`;
    const facts = extractDependencyFacts(text, ["expo"]);
    expect(facts.length).toBe(1);
    expect(facts[0]).toMatchObject({ packageName: "expo", dependencyKey: "my-expo", isAlias: true, resolutionRange: "^50.0.0", declaredVersion: "npm:expo@^50.0.0" });
  });
  test("shadow: key equals the tracked name but value aliases a DIFFERENT package → NOT a finding", () => {
    const text = `{ "dependencies": { "expo": "npm:@corp/expo-fork@^2" } }`;
    expect(extractDependencyFacts(text, ["expo"]).length).toBe(0);
  });
  test("self-alias 'expo':'npm:expo@^50' is still a finding", () => {
    const text = `{ "dependencies": { "expo": "npm:expo@^50.0.0" } }`;
    const facts = extractDependencyFacts(text, ["expo"]);
    expect(facts.length).toBe(1);
    expect(facts[0]).toMatchObject({ packageName: "expo", dependencyKey: "expo", isAlias: true });
  });
  test("two distinct aliases of one package are two findings", () => {
    const text = `{ "dependencies": { "a-expo": "npm:expo@^50", "b-expo": "npm:expo@^51" } }`;
    const facts = extractDependencyFacts(text, ["expo"]);
    expect(facts.length).toBe(2);
    expect(facts.map((f) => f.dependencyKey).sort()).toEqual(["a-expo", "b-expo"]);
  });
  test("untracked packages produce no findings", () => {
    const text = `{ "dependencies": { "lodash": "^4", "react": "^18" } }`;
    expect(extractDependencyFacts(text, ["expo"]).length).toBe(0);
  });
  test("overrides recorded ONLY when also declared normally", () => {
    const declaredAndOverridden = `{
  "dependencies": { "expo": "^50.0.0" },
  "overrides": { "expo": "50.0.4" }
}`;
    const facts = extractDependencyFacts(declaredAndOverridden, ["expo"]);
    expect(facts.map((f) => f.dependencyType).sort()).toEqual(["dependencies", "overrides"]);
    // overrides WITHOUT a normal declaration is not a standalone appearance
    const overrideOnly = `{ "overrides": { "expo": "50.0.4" } }`;
    expect(extractDependencyFacts(overrideOnly, ["expo"]).length).toBe(0);
  });
  test("nested npm overrides ('.' entry) and yarn resolutions glob", () => {
    const nested = [
      `{`, //                        1
      `  "dependencies": { "expo": "^50" },`, // 2
      `  "overrides": {`, //         3
      `    "expo": {`, //            4
      `      ".": "50.0.4",`, //     5
      `      "react": "18"`, //      6
      `    }`, //                    7
      `  }`, //                      8
      `}`, //                        9
    ].join("\n");
    const facts = extractDependencyFacts(nested, ["expo"]);
    const override = facts.find((f) => f.dependencyType === "overrides");
    expect(override?.declaredVersion).toBe("50.0.4");
    expect(override?.manifestLine).toBe(5); // the "." key line, not the parent "expo" key line (4)

    const glob = `{
  "dependencies": { "expo": "^50" },
  "resolutions": { "**/expo": "50.0.4" }
}`;
    const rfacts = extractDependencyFacts(glob, ["expo"]);
    expect(rfacts.some((f) => f.dependencyType === "resolutions" && f.declaredVersion === "50.0.4")).toBe(true);
  });
  test("an override key with a version selector (foo@^1) matches the tracked name", () => {
    const text = `{ "dependencies": { "expo": "^50" }, "overrides": { "expo@^50": "50.0.4" } }`;
    const facts = extractDependencyFacts(text, ["expo"]);
    expect(facts.some((f) => f.dependencyType === "overrides" && f.declaredVersion === "50.0.4")).toBe(true);
    // a scoped selector too
    const scoped = `{ "dependencies": { "@scope/pkg": "^1" }, "overrides": { "@scope/pkg@^1": "1.2.3" } }`;
    expect(extractDependencyFacts(scoped, ["@scope/pkg"]).some((f) => f.dependencyType === "overrides")).toBe(true);
  });
  test("an UNSCOPED tracked name does NOT match a scoped resolution glob key", () => {
    const text = `{
  "dependencies": { "pkg": "^1" },
  "resolutions": { "**/@scope/pkg": "9.9.9" }
}`;
    // tracking unscoped "pkg": the scoped "**/@scope/pkg" resolution must NOT be attributed to it
    const facts = extractDependencyFacts(text, ["pkg"]);
    expect(facts.some((f) => f.dependencyType === "resolutions")).toBe(false);
    // …but tracking the scoped name DOES match
    const scoped = extractDependencyFacts(`{ "dependencies": { "@scope/pkg": "^1" }, "resolutions": { "**/@scope/pkg": "9.9.9" } }`, ["@scope/pkg"]);
    expect(scoped.some((f) => f.dependencyType === "resolutions" && f.declaredVersion === "9.9.9")).toBe(true);
  });
  test("a parent-only nested override ({expo:{other:..}}) yields NO empty-version override fact", () => {
    const text = `{
  "dependencies": { "expo": "^50" },
  "overrides": { "expo": { "react": "18" } }
}`;
    const overrides = extractDependencyFacts(text, ["expo"]).filter((f) => f.dependencyType === "overrides");
    expect(overrides).toEqual([]); // "expo depends on react" is not a direct override of expo
  });
  test("scoped resolution glob keys keep the full scoped tail", () => {
    const text = `{
  "dependencies": { "@scope/pkg": "^1" },
  "resolutions": { "**/@scope/pkg": "1.2.3" }
}`;
    const facts = extractDependencyFacts(text, ["@scope/pkg"]);
    expect(facts.some((f) => f.dependencyType === "resolutions" && f.packageName === "@scope/pkg" && f.declaredVersion === "1.2.3")).toBe(true);
  });
  test("JSONC manifest with comments and trailing commas is parsed", () => {
    const text = `{
  // deps
  "dependencies": { "expo": "^50.0.0", },
}`;
    expect(extractDependencyFacts(text, ["expo"]).length).toBe(1);
  });
});

describe("installNameSet — §5.F", () => {
  test("collects alias keys + the unshadowed registry name; excludes override/resolution keys", () => {
    const text = `{
  "dependencies": { "expo": "^50", "aliased-expo": "npm:expo@^50" },
  "overrides": { "expo": "50.0.4" }
}`;
    const facts = extractDependencyFacts(text, ["expo"]);
    const names = installNameSet(facts, "expo");
    expect([...names].sort()).toEqual(["aliased-expo", "expo"]);
  });
  test("alias-only install does not include the bare registry name", () => {
    const facts = extractDependencyFacts(`{ "dependencies": { "my-expo": "npm:expo@^50" } }`, ["expo"]);
    expect([...installNameSet(facts, "expo")]).toEqual(["my-expo"]);
  });
});

describe("locate + nearest lockfile (§5.C/§5.D)", () => {
  const noExclude = () => false;
  test("partitions manifests and lockfiles, skips node_modules", () => {
    const paths = [
      "package.json",
      "package-lock.json",
      "apps/web/package.json",
      "apps/web/yarn.lock",
      "node_modules/foo/package.json",
      "README.md",
    ];
    const { manifests, lockfiles } = locateManifests(paths, noExclude);
    expect(manifests).toEqual(["package.json", "apps/web/package.json"]);
    expect(lockfiles.map((l) => l.path).sort()).toEqual(["apps/web/yarn.lock", "package-lock.json"]);
  });
  test("honors an exclude predicate", () => {
    const paths = ["package.json", "dist/package.json"];
    const { manifests } = locateManifests(paths, (p) => p.startsWith("dist/"));
    expect(manifests).toEqual(["package.json"]);
  });
  test("nearest-ancestor lockfile with name precedence", () => {
    const { lockfiles } = locateManifests(
      ["npm-shrinkwrap.json", "package-lock.json", "apps/web/package.json", "apps/web/package.json"],
      noExclude,
    );
    // root has both shrinkwrap + lock → shrinkwrap wins; nested manifest inherits it
    const lf = nearestLockfile("apps/web/package.json", lockfiles);
    expect(lf?.path).toBe("npm-shrinkwrap.json");
  });
  test("a nested lockfile shadows the ancestor for its own subtree", () => {
    const lockfiles = locateManifests(["yarn.lock", "apps/api/pnpm-lock.yaml"], noExclude).lockfiles;
    expect(nearestLockfile("apps/api/package.json", lockfiles)?.kind).toBe("pnpm");
    expect(nearestLockfile("apps/web/package.json", lockfiles)?.kind).toBe("yarn");
  });
  test("bun.lock text precedes bun.lockb binary", () => {
    const lockfiles = locateManifests(["bun.lock", "bun.lockb"], noExclude).lockfiles;
    const lf = nearestLockfile("package.json", lockfiles);
    expect(lf?.binary).toBe(false);
  });
  test("no lockfile in the tree → null", () => {
    expect(nearestLockfile("package.json", [])).toBeNull();
  });
});

describe("resolveOwningManifest — §5.F", () => {
  const mk = (dir: string, text: string): [string, { manifestPath: string; facts: DependencyFact[] }] => {
    const manifestPath = dir === "" ? "package.json" : `${dir}/package.json`;
    return [dir, { manifestPath, facts: extractDependencyFacts(text, ["expo"]) }];
  };
  test("nearest ancestor that declares the package wins; hoisting reaches the root", () => {
    const byDir = new Map([
      mk("", `{ "dependencies": { "expo": "^50" } }`),
      mk("apps/web", `{ "dependencies": { "react": "^18" } }`), // declares no expo
    ]);
    // a file under apps/web resolves expo via the ROOT manifest (hoisting)
    const owning = resolveOwningManifest("apps/web/src/App.tsx", byDir, "expo");
    expect(owning?.manifestPath).toBe("package.json");
    expect([...owning!.installNames]).toEqual(["expo"]);
  });
  test("nearest wins when it declares the package (alias)", () => {
    const byDir = new Map([
      mk("", `{ "dependencies": { "expo": "^50" } }`),
      mk("apps/web", `{ "dependencies": { "web-expo": "npm:expo@^51" } }`),
    ]);
    const owning = resolveOwningManifest("apps/web/src/App.tsx", byDir, "expo");
    expect(owning?.manifestPath).toBe("apps/web/package.json");
    expect([...owning!.installNames]).toEqual(["web-expo"]);
  });
  test("a chain declaring none resolves to null", () => {
    const byDir = new Map([mk("", `{ "dependencies": { "react": "^18" } }`)]);
    expect(resolveOwningManifest("src/App.tsx", byDir, "expo")).toBeNull();
  });
});

describe("path helpers", () => {
  test("dirOf/baseOf", () => {
    expect(dirOf("a/b/c.json")).toBe("a/b");
    expect(dirOf("c.json")).toBe("");
    expect(baseOf("a/b/c.json")).toBe("c.json");
    expect(baseOf("c.json")).toBe("c.json");
  });
});
