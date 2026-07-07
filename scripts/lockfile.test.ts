import { expect, test, describe } from "bun:test";
import { resolveFromLockfile, type ResolveInput } from "./lockfile.ts";

const resolve = (partial: Partial<ResolveInput> & Pick<ResolveInput, "kind" | "text">): ReturnType<typeof resolveFromLockfile> =>
  resolveFromLockfile({
    manifestDir: "",
    dependencyKey: "expo",
    registryName: "expo",
    declaredRange: "^50.0.0",
    ...partial,
  });

describe("npm v2/v3 (packages map)", () => {
  const v3 = `{
  "name": "root",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "root", "dependencies": { "expo": "^50.0.0" } },
    "node_modules/expo": {
      "version": "50.0.4",
      "resolved": "https://registry.npmjs.org/expo/-/expo-50.0.4.tgz",
      "integrity": "sha512-abc"
    }
  }
}`;
  test("resolves the hoisted install entry", () => {
    const r = resolve({ kind: "npm", text: v3 });
    expect(r.matched).toBe(true);
    expect(r.resolvedVersion).toBe("50.0.4");
    expect(r.isRegistry).toBe(true);
    expect(r.lines).toEqual([6]); // the KEY line of "node_modules/expo"
  });
  test("alias entry carries name=realName", () => {
    // realistic npm alias: the root packages entry declares the ALIAS key → npm:<real>@range
    const aliased = `{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "root", "dependencies": { "my-expo": "npm:expo@^50.0.0" } },
    "node_modules/my-expo": { "name": "expo", "version": "50.0.4", "resolved": "https://registry.npmjs.org/expo/-/expo-50.0.4.tgz" }
  }
}`;
    const r = resolve({ kind: "npm", text: aliased, dependencyKey: "my-expo" });
    expect(r.resolvedVersion).toBe("50.0.4");
    expect(r.realName).toBe("expo");
    expect(r.isRegistry).toBe(true);
  });
  test("a declared tarball-URL spec is non-registry even with a concrete install version", () => {
    const v3 = `{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "root", "dependencies": { "foo": "https://github.com/u/foo.tgz" } },
    "node_modules/foo": { "version": "1.0.0", "resolved": "https://github.com/u/foo.tgz" }
  }
}`;
    const r = resolve({ kind: "npm", text: v3, dependencyKey: "foo", registryName: "foo" });
    expect(r.isRegistry).toBe(false);
  });
  test("declared tarball spec whose install entry names a DIFFERENT package → NO_MATCH", () => {
    const v3 = `{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "root", "dependencies": { "foo": "https://github.com/u/foo.tgz" } },
    "node_modules/foo": { "name": "not-foo", "version": "1.0.0", "resolved": "https://github.com/u/foo.tgz" }
  }
}`;
    expect(resolve({ kind: "npm", text: v3, dependencyKey: "foo", registryName: "foo" }).matched).toBe(false);
  });
  test("a manifest packages entry that does NOT declare the key → NO_MATCH (transitive, not direct)", () => {
    const v3 = `{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "root", "dependencies": { "react": "^18" } },
    "node_modules/expo": { "version": "50.0.4", "resolved": "https://registry.npmjs.org/expo/-/expo-50.0.4.tgz" }
  }
}`;
    expect(resolve({ kind: "npm", text: v3, dependencyKey: "expo" }).matched).toBe(false);
  });
  test("nearest-first node_modules chain for a nested workspace", () => {
    const nested = `{
  "lockfileVersion": 3,
  "packages": {
    "apps/web/node_modules/expo": { "version": "51.0.0", "resolved": "https://registry.npmjs.org/expo/-/expo-51.0.0.tgz" },
    "node_modules/expo": { "version": "50.0.4", "resolved": "https://registry.npmjs.org/expo/-/expo-50.0.4.tgz" }
  }
}`;
    expect(resolve({ kind: "npm", text: nested, manifestDir: "apps/web" }).resolvedVersion).toBe("51.0.0"); // nearest wins
    expect(resolve({ kind: "npm", text: nested, manifestDir: "apps/api" }).resolvedVersion).toBe("50.0.4"); // falls to hoisted root
  });
  test("link:true is non-registry", () => {
    const link = `{ "lockfileVersion": 3, "packages": { "node_modules/expo": { "resolved": "", "link": true } } }`;
    const r = resolve({ kind: "npm", text: link });
    expect(r.isRegistry).toBe(false);
  });
  test("git resolved reference is non-registry", () => {
    const git = `{ "lockfileVersion": 3, "packages": { "node_modules/expo": { "version": "50.0.4", "resolved": "git+https://github.com/expo/expo.git#abc" } } }`;
    const r = resolve({ kind: "npm", text: git });
    expect(r.isRegistry).toBe(false);
    expect(r.resolvedVersion).toContain("git+");
  });
});

describe("npm v1 (dependencies map)", () => {
  const v1 = `{
  "lockfileVersion": 1,
  "dependencies": {
    "expo": { "version": "50.0.4", "resolved": "https://registry.npmjs.org/expo/-/expo-50.0.4.tgz" }
  }
}`;
  test("reads dependencies.<key>.version", () => {
    const r = resolve({ kind: "npm", text: v1 });
    expect(r.resolvedVersion).toBe("50.0.4");
    expect(r.isRegistry).toBe(true);
    expect(r.lines).toEqual([4]);
  });
  test("v1 tarball-URL version is non-registry", () => {
    const v1 = `{ "lockfileVersion": 1, "dependencies": { "expo": { "version": "https://github.com/expo/expo/archive/x.tgz" } } }`;
    const r = resolve({ kind: "npm", text: v1 });
    expect(r.isRegistry).toBe(false);
  });
  test("v1 alias: version 'npm:<real>@x.y.z' → concrete version after the LAST @", () => {
    const aliased = `{ "lockfileVersion": 1, "dependencies": { "my-expo": { "version": "npm:expo@50.0.4" } } }`;
    const r = resolve({ kind: "npm", text: aliased, dependencyKey: "my-expo" });
    expect(r.resolvedVersion).toBe("50.0.4");
    expect(r.realName).toBe("expo");
    expect(r.isRegistry).toBe(true);
  });
});

describe("yarn (classic + berry)", () => {
  test("classic single descriptor", () => {
    const y = `# yarn lockfile v1
expo@^50.0.0:
  version "50.0.4"
  resolved "https://registry.yarnpkg.com/expo/-/expo-50.0.4.tgz#abc"
  integrity sha512-xyz
`;
    const r = resolve({ kind: "yarn", text: y });
    expect(r.resolvedVersion).toBe("50.0.4");
    expect(r.isRegistry).toBe(true);
    expect(r.lines?.[0]).toBe(2);
  });
  test("multi-match disambiguated by the declared range", () => {
    const y = `lodash@^3.0.0:
  version "3.10.1"

lodash@^4.0.0:
  version "4.17.21"
`;
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "lodash", registryName: "lodash", declaredRange: "^4.0.0" }).resolvedVersion).toBe("4.17.21");
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "lodash", registryName: "lodash", declaredRange: "^3.0.0" }).resolvedVersion).toBe("3.10.1");
  });
  test("multi-match ALIAS disambiguation compares range-only (npm:<real>@<range> normalized)", () => {
    const y = `"my-expo@npm:expo@^50.0.0":
  version: 50.0.4
  resolution: "expo@npm:50.0.4"

"my-expo@npm:expo@^51.0.0":
  version: 51.0.1
  resolution: "expo@npm:51.0.1"
`;
    // declaredRange is range-only (^51.0.0); the descriptor remainder is npm:expo@^51.0.0
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "my-expo", registryName: "expo", declaredRange: "^51.0.0" }).resolvedVersion).toBe("51.0.1");
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "my-expo", registryName: "expo", declaredRange: "^50.0.0" }).resolvedVersion).toBe("50.0.4");
  });
  test("declaredRange matching the NON-first descriptor of a comma-joined block wins over a competing block", () => {
    const y = `lodash@^3.0.0:
  version "3.10.1"

lodash@^4.0.0, lodash@^4.17.0:
  version "4.17.21"
`;
    // ^4.17.0 is the SECOND descriptor of the second block — must resolve 4.17.21, not 3.10.1
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "lodash", registryName: "lodash", declaredRange: "^4.17.0" }).resolvedVersion).toBe("4.17.21");
  });
  test("multi-match with a direct git+ssh descriptor whose range contains user@host is not mangled", () => {
    const y = `foo@^1.0.0:
  version "1.0.0"

foo@git+ssh://git@github.com/acme/foo.git#deadbeef:
  version "2.0.0"
`;
    // declaredRange is the git+ssh spec (contains @) — disambiguation must pick the 2nd block
    const r = resolve({ kind: "yarn", text: y, dependencyKey: "foo", registryName: "foo", declaredRange: "git+ssh://git@github.com/acme/foo.git#deadbeef" });
    expect(r.isRegistry).toBe(false);
  });
  test("comma-joined scoped descriptors", () => {
    const y = `"@babel/core@npm:^7.0.0", "@babel/core@npm:^7.10.0":
  version: 7.10.4
  resolution: "@babel/core@npm:7.10.4"
`;
    const r = resolve({ kind: "yarn", text: y, dependencyKey: "@babel/core", registryName: "@babel/core", declaredRange: "^7.0.0" });
    expect(r.resolvedVersion).toBe("7.10.4");
    expect(r.realName).toBe("@babel/core");
  });
  test("berry single-quote-wrapped comma-joined block: declaredRange matches an interior descriptor", () => {
    // berry wraps the WHOLE list in one quote pair with commas INSIDE (canonical yarn 2/3/4)
    const y = `"lodash@npm:^3.0.0":
  version: 3.10.1
  resolution: "lodash@npm:3.10.1"

"lodash@npm:^4.0.0, lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
`;
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "lodash", registryName: "lodash", declaredRange: "^4.17.21" }).resolvedVersion).toBe("4.17.21");
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "lodash", registryName: "lodash", declaredRange: "^4.0.0" }).resolvedVersion).toBe("4.17.21");
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "lodash", registryName: "lodash", declaredRange: "^3.0.0" }).resolvedVersion).toBe("3.10.1");
  });
  test("berry direct with npm: protocol on the descriptor", () => {
    const y = `"expo@npm:^50.0.0":
  version: 50.0.4
  resolution: "expo@npm:50.0.4"
`;
    expect(resolve({ kind: "yarn", text: y }).resolvedVersion).toBe("50.0.4");
  });
  test("classic alias (no berry resolution field) resolving to a different package → NO_MATCH", () => {
    const y = `"my-expo@npm:not-expo@^1":
  version "1.0.0"
  resolved "https://registry.yarnpkg.com/not-expo/-/not-expo-1.0.0.tgz#abc"
`;
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "my-expo", registryName: "expo", declaredRange: "^1" }).matched).toBe(false);
  });
  test("workspace: protocol is non-registry even with a semver version", () => {
    const y = `"my-pkg@workspace:packages/my-pkg":
  version: 0.0.0-use.local
  resolution: "my-pkg@workspace:packages/my-pkg"
`;
    const r = resolve({ kind: "yarn", text: y, dependencyKey: "my-pkg", registryName: "my-pkg", declaredRange: "workspace:*" });
    expect(r.isRegistry).toBe(false);
  });
});

describe("pnpm (v5/v6/v9)", () => {
  test("v6 object form importer edge", () => {
    const p = `lockfileVersion: '6.0'
importers:
  .:
    dependencies:
      expo:
        specifier: ^50.0.0
        version: 50.0.4
`;
    const r = resolve({ kind: "pnpm", text: p });
    expect(r.resolvedVersion).toBe("50.0.4");
    expect(r.isRegistry).toBe(true);
    expect(r.lines?.[0]).toBe(5);
  });
  test("v5 string form + specifiers sibling (single package, no importers)", () => {
    const p = `lockfileVersion: 5.4
dependencies:
  expo: 50.0.4
specifiers:
  expo: ^50.0.0
`;
    expect(resolve({ kind: "pnpm", text: p }).resolvedVersion).toBe("50.0.4");
  });
  test("string form with a NON-registry sibling specifier is non-registry despite a concrete version", () => {
    const p = `lockfileVersion: 5.4
dependencies:
  local: 1.0.0
specifiers:
  local: workspace:*
`;
    const r = resolve({ kind: "pnpm", text: p, dependencyKey: "local", registryName: "local" });
    expect(r.isRegistry).toBe(false);
  });
  test("alias resolved reference name@version", () => {
    const p = `importers:
  .:
    dependencies:
      left:
        specifier: npm:left-pad@^1
        version: left-pad@1.3.0
`;
    const r = resolve({ kind: "pnpm", text: p, dependencyKey: "left", registryName: "left-pad" });
    expect(r.resolvedVersion).toBe("1.3.0");
    expect(r.realName).toBe("left-pad");
  });
  test("peer-suffixed version is stripped (nested parens too)", () => {
    const p = `importers:
  .:
    dependencies:
      foo:
        specifier: ^1
        version: 1.2.3(react@18.0.0)(bar@2(baz@3))
`;
    expect(resolve({ kind: "pnpm", text: p, dependencyKey: "foo", registryName: "foo" }).resolvedVersion).toBe("1.2.3");
  });
  test("link:/workspace: resolved reference is non-registry", () => {
    const p = `importers:
  .:
    dependencies:
      local:
        specifier: workspace:*
        version: link:../local
`;
    const r = resolve({ kind: "pnpm", text: p, dependencyKey: "local", registryName: "local" });
    expect(r.isRegistry).toBe(false);
  });
  test("v5 underscore peer suffix is stripped (string form and slash key)", () => {
    const stringForm = `importers:
  .:
    dependencies:
      react-dom:
        specifier: ^18
        version: 18.2.0_react@17.0.2
`;
    expect(resolve({ kind: "pnpm", text: stringForm, dependencyKey: "react-dom", registryName: "react-dom" }).resolvedVersion).toBe("18.2.0");
    const slashKey = `importers:
  .:
    dependencies:
      react-dom:
        specifier: ^18
        version: /react-dom/18.2.0_react@17.0.2
`;
    const r = resolve({ kind: "pnpm", text: slashKey, dependencyKey: "react-dom", registryName: "react-dom" });
    expect(r.resolvedVersion).toBe("18.2.0");
  });
  test("a package name containing '_' is NOT mistaken for a peer separator", () => {
    const p = `importers:
  .:
    dependencies:
      my_pkg:
        specifier: ^1
        version: my_pkg@1.2.3
`;
    expect(resolve({ kind: "pnpm", text: p, dependencyKey: "my_pkg", registryName: "my_pkg" }).resolvedVersion).toBe("1.2.3");
  });
  test("an underscore-NAMED package WITH a v5 peer resolves name and version correctly", () => {
    const p = `importers:
  .:
    dependencies:
      type_fest:
        specifier: ^1
        version: type_fest@1.0.0_typescript@4.5.0
`;
    const r = resolve({ kind: "pnpm", text: p, dependencyKey: "type_fest", registryName: "type_fest" });
    expect(r.resolvedVersion).toBe("1.0.0");
    expect(r.matched).toBe(true); // NOT silently dropped by the realName guard
  });
  test("nested workspace importer key", () => {
    const p = `importers:
  apps/web:
    dependencies:
      expo:
        specifier: ^51.0.0
        version: 51.0.0
`;
    expect(resolve({ kind: "pnpm", text: p, manifestDir: "apps/web" }).resolvedVersion).toBe("51.0.0");
  });
  test("resolves against a REAL lockfile whose packages/snapshots sections have flow collections", () => {
    // the packages: section (with `resolution: {integrity: …}`, `engines: {node: …}`, `os: [...]`)
    // would make yamlLite throw if parsed — the resolver must slice it away and still resolve.
    const p = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  .:
    dependencies:
      expo:
        specifier: ^50.0.0
        version: 50.0.4
packages:
  expo@50.0.4:
    resolution: {integrity: sha512-abcdefghijklmnop==}
    engines: {node: '>=18'}
    os: [darwin, linux]
snapshots:
  expo@50.0.4:
    dependencies:
      react: 18.2.0
`;
    const r = resolve({ kind: "pnpm", text: p, dependencyKey: "expo", registryName: "expo" });
    expect(r.matched).toBe(true);
    expect(r.resolvedVersion).toBe("50.0.4");
  });
});

describe("bun (bun.lock JSONC + bun.lockb binary)", () => {
  test("resolves via workspaces edge + packages tuple", () => {
    const b = `{
  "lockfileVersion": 0,
  "workspaces": { "": { "dependencies": { "expo": "^50.0.0" } } },
  "packages": { "expo": ["expo@50.0.4", {}, "sha512-abc"] }
}`;
    const r = resolve({ kind: "bun", text: b });
    expect(r.resolvedVersion).toBe("50.0.4");
    expect(r.realName).toBe("expo");
    expect(r.isRegistry).toBe(true);
  });
  test("bun.lockb (binary) is a non-match — no line-level parse", () => {
    const r = resolve({ kind: "bun", text: "", binary: true });
    expect(r.matched).toBe(false);
  });
  test("non-registry tuple id (protocol AFTER the name separator) is classified non-registry", () => {
    for (const spec of ["file:../foo", "git+https://github.com/u/foo.git#abc", "workspace:*"]) {
      const b = `{ "workspaces": { "": { "dependencies": { "foo": "${spec.replace(/"/g, "")}" } } }, "packages": { "foo": ["foo@${spec}", {}] } }`;
      const r = resolve({ kind: "bun", text: b, dependencyKey: "foo", registryName: "foo" });
      expect({ spec, isRegistry: r.isRegistry }).toEqual({ spec, isRegistry: false });
    }
  });
});

describe("real-name confirmation (§5.D — a key aliasing a DIFFERENT package is NOT our finding)", () => {
  test("npm: entry.name contradicts registryName → NO_MATCH", () => {
    const v3 = `{ "lockfileVersion": 3, "packages": { "node_modules/my-expo": { "name": "not-expo", "version": "1.0.0" } } }`;
    expect(resolve({ kind: "npm", text: v3, dependencyKey: "my-expo" }).matched).toBe(false);
  });
  test("npm v1: alias to a different package → NO_MATCH", () => {
    const v1 = `{ "lockfileVersion": 1, "dependencies": { "my-expo": { "version": "npm:not-expo@1.0.0" } } }`;
    expect(resolve({ kind: "npm", text: v1, dependencyKey: "my-expo" }).matched).toBe(false);
  });
  test("yarn: resolution names a different package → NO_MATCH", () => {
    const y = `"my-expo@npm:not-expo@^1":
  version: 1.0.0
  resolution: "not-expo@npm:1.0.0"
`;
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "my-expo", declaredRange: "npm:not-expo@^1" }).matched).toBe(false);
  });
  test("pnpm: alias ref names a different package → NO_MATCH", () => {
    const p = `importers:
  .:
    dependencies:
      my-expo:
        specifier: npm:not-expo@^1
        version: not-expo@1.0.0
`;
    expect(resolve({ kind: "pnpm", text: p, dependencyKey: "my-expo" }).matched).toBe(false);
  });
  test("bun: tuple id names a different package → NO_MATCH", () => {
    const b = `{ "workspaces": { "": { "dependencies": { "my-expo": "npm:not-expo@^1" } } }, "packages": { "my-expo": ["not-expo@1.0.0", {}] } }`;
    expect(resolve({ kind: "bun", text: b, dependencyKey: "my-expo" }).matched).toBe(false);
  });
  test("npm link entry naming a different package → NO_MATCH (realName carried on non-registry path)", () => {
    const v3 = `{ "lockfileVersion": 3, "packages": { "node_modules/my-expo": { "name": "not-expo", "link": true, "resolved": "" } } }`;
    expect(resolve({ kind: "npm", text: v3, dependencyKey: "my-expo" }).matched).toBe(false);
  });
  test("yarn non-registry descriptor resolving to a different package → NO_MATCH", () => {
    const y = `"my-x@patch:not-x@npm%3A1.0.0#builtin":
  version: 1.0.0
  resolution: "not-x@patch:not-x@npm%3A1.0.0#builtin"
`;
    expect(resolve({ kind: "yarn", text: y, dependencyKey: "my-x", registryName: "x", declaredRange: "patch:..." }).matched).toBe(false);
  });
  test("bun non-registry tuple resolving to a different package → NO_MATCH", () => {
    const b = `{ "workspaces": { "": { "dependencies": { "my-x": "file:../x" } } }, "packages": { "my-x": ["not-x@file:../x", {}] } }`;
    expect(resolve({ kind: "bun", text: b, dependencyKey: "my-x", registryName: "x" }).matched).toBe(false);
  });
});

describe("pnpm non-registry via specifier / alias-version protocol", () => {
  test("object-form catalog: specifier is non-registry even with a concrete version (§5.E)", () => {
    const p = `importers:
  .:
    dependencies:
      expo:
        specifier: 'catalog:'
        version: 50.0.4
`;
    const r = resolve({ kind: "pnpm", text: p, dependencyKey: "expo", registryName: "expo" });
    expect(r.isRegistry).toBe(false);
  });
  test("non-registry specifier whose resolved ref names a DIFFERENT package → NO_MATCH", () => {
    const p = `importers:
  .:
    dependencies:
      my-local:
        specifier: workspace:*
        version: not-local@1.0.0
`;
    expect(resolve({ kind: "pnpm", text: p, dependencyKey: "my-local", registryName: "local" }).matched).toBe(false);
  });
  test("alias whose version part is a protocol → non-registry", () => {
    const p = `importers:
  .:
    dependencies:
      expo:
        specifier: file:../expo
        version: expo@file:../expo
`;
    const r = resolve({ kind: "pnpm", text: p, dependencyKey: "expo", registryName: "expo" });
    expect(r.isRegistry).toBe(false);
  });
});

describe("yarn protocol + span edge cases", () => {
  test("patch: protocol (with an inner @npm:) is non-registry, not a semver registry version", () => {
    const y = `"typescript@patch:typescript@npm%3A5.0.4#~builtin<compat/typescript>":
  version: 5.0.4
  resolution: "typescript@patch:typescript@npm%3A5.0.4#~builtin<compat/typescript>"
`;
    const r = resolve({ kind: "yarn", text: y, dependencyKey: "typescript", registryName: "typescript", declaredRange: "patch:..." });
    expect(r.isRegistry).toBe(false);
    expect(r.resolvedVersion).toContain("patch:");
  });
  test("plain https/http git-tarball descriptor is non-registry (§5.E)", () => {
    const y = `"foo@https://github.com/u/foo.git#deadbeef":
  version: 1.0.0
  resolution: "foo@https://github.com/u/foo.git#deadbeef"
`;
    const r = resolve({ kind: "yarn", text: y, dependencyKey: "foo", registryName: "foo", declaredRange: "https://github.com/u/foo.git" });
    expect(r.isRegistry).toBe(false);
  });
  test("line span excludes the blank separator line", () => {
    const y = `expo@^50.0.0:
  version "50.0.4"

lodash@^4.0.0:
  version "4.17.21"
`;
    expect(resolve({ kind: "yarn", text: y }).lines).toEqual([1, 2]); // NOT [1,2,3]
  });
});

describe("robustness", () => {
  test("an unparseable lockfile returns a non-match, never throws", () => {
    expect(resolve({ kind: "npm", text: "{ not json" }).matched).toBe(false);
    expect(resolve({ kind: "pnpm", text: "a: &anchor\nb: *anchor" }).matched).toBe(false);
    expect(resolve({ kind: "yarn", text: "\x00\x01 garbage" }).matched).toBe(false);
  });
  test("a key absent from the lockfile is a non-match", () => {
    const v3 = `{ "lockfileVersion": 3, "packages": { "node_modules/other": { "version": "1.0.0" } } }`;
    expect(resolve({ kind: "npm", text: v3 }).matched).toBe(false);
  });
});
