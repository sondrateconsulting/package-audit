import { expect, test, describe } from "bun:test";
import { scanCli, deriveTerms, classifyFile, type CliTermSet, type CliScanContext } from "./cliScanner.ts";

const ctx = (filePath: string): CliScanContext => ({
  githubHost: "github.com",
  organization: "org-a",
  repository: "repo",
  branch: "main",
  commitSha: "abc123def",
  filePath,
});
const expo: CliTermSet[] = [{ packageName: "expo", name: "expo", binNames: [] }];
const scan = (content: string, path: string, terms = expo) =>
  scanCli(content, ctx(path), terms).map((r) => ({ context: r.context, line: r.lineNumber }));

describe("classifyFile", () => {
  test("recognizes the searched file kinds", () => {
    expect(classifyFile("package.json")).toBe("package-json");
    expect(classifyFile("scripts/build.sh")).toBe("shell");
    expect(classifyFile(".github/workflows/ci.yml")).toBe("workflow");
    expect(classifyFile("Dockerfile")).toBe("dockerfile");
    expect(classifyFile("Makefile")).toBe("makefile");
    expect(classifyFile("src/index.ts")).toBe("other");
  });
});

describe("deriveTerms — scoped vs unscoped (§5.G)", () => {
  test("unscoped name: bare + exec terms include the name; runner terms include it too", () => {
    const d = deriveTerms({ packageName: "expo", name: "expo", binNames: ["expo-cli"] });
    expect(d.runnerTerms.has("expo")).toBe(true);
    expect(d.execAndBareTerms.has("expo")).toBe(true);
    expect(d.execAndBareTerms.has("expo-cli")).toBe(true);
  });
  test("scoped name: the scoped specifier is a runner term but NOT a bare term", () => {
    const d = deriveTerms({ packageName: "@scope/pkg", name: "@scope/pkg", binNames: ["pkg-bin"] });
    expect(d.runnerTerms.has("@scope/pkg")).toBe(true);
    expect(d.execAndBareTerms.has("@scope/pkg")).toBe(false); // scoped specifier never a bare token
    expect(d.execAndBareTerms.has("pkg-bin")).toBe(true); // bins can be bare
  });
});

describe("scanCli — package.json scripts (§7 context scripts.<name>)", () => {
  const pkg = `{
  "scripts": {
    "start": "expo start",
    "build": "webpack && expo export",
    "test": "jest",
    "deploy": "npx expo@latest publish"
  }
}`;
  test("finds bare + runner invocations with scripts.<name> context and the key line", () => {
    const rows = scan(pkg, "package.json");
    expect(rows).toContainEqual({ context: "scripts.start", line: 3 });
    expect(rows).toContainEqual({ context: "scripts.build", line: 4 });
    expect(rows).toContainEqual({ context: "scripts.deploy", line: 6 });
    expect(rows.find((r) => r.context === "scripts.test")).toBeUndefined(); // jest, not expo
  });
  test("bare token does not substring-match a longer word", () => {
    const p = `{ "scripts": { "x": "run-export-thing && exposeport" } }`;
    expect(scan(p, "package.json")).toEqual([]);
  });
});

describe("scanCli — runner forms and scoping", () => {
  test("npx with flags and version suffix matches (npx -y expo@latest)", () => {
    expect(scan(`{ "scripts": { "a": "npx -y expo@latest doctor" } }`, "package.json").length).toBe(1);
  });
  test("a scoped package matches its runner specifier but NOT a bare unscoped tail", () => {
    const scoped: CliTermSet[] = [{ packageName: "@scope/pkg", name: "@scope/pkg", binNames: [] }];
    expect(scan(`{ "scripts": { "a": "npx @scope/pkg build" } }`, "package.json", scoped).length).toBe(1);
    // a bare `pkg` (the unscoped tail) must NOT match the scoped package
    expect(scan(`{ "scripts": { "a": "pkg build" } }`, "package.json", scoped)).toEqual([]);
  });
  test("bin terms match bare tokens once introspection provides them", () => {
    const withBin: CliTermSet[] = [{ packageName: "@scope/pkg", name: "@scope/pkg", binNames: ["mycli"] }];
    expect(scan(`{ "scripts": { "a": "mycli run" } }`, "package.json", withBin).length).toBe(1);
  });
  test("pnpm exec matches an unscoped name; scoped specifier is not an exec/bare term", () => {
    expect(scan(`{ "scripts": { "a": "pnpm exec expo doctor" } }`, "package.json").length).toBe(1);
    const scoped: CliTermSet[] = [{ packageName: "@scope/pkg", name: "@scope/pkg", binNames: [] }];
    expect(scan(`{ "scripts": { "a": "pnpm exec pkg" } }`, "package.json", scoped)).toEqual([]);
  });
  test("a LATER same-runner occurrence in a compound command is found (scoped has no bare fallback)", () => {
    const scoped: CliTermSet[] = [{ packageName: "@scope/pkg", name: "@scope/pkg", binNames: [] }];
    expect(scan(`{ "scripts": { "ci": "npx playwright install && npx @scope/pkg run" } }`, "package.json", scoped).length).toBe(1);
    expect(scan(`{ "scripts": { "ci": "npx foo; npx @scope/pkg deploy" } }`, "package.json", scoped).length).toBe(1);
  });
  test("a runner target GLUED to a shell operator (no spaces) is still captured (scoped)", () => {
    const scoped: CliTermSet[] = [{ packageName: "@scope/pkg", name: "@scope/pkg", binNames: [] }];
    expect(scan(`{ "scripts": { "a": "npx @scope/pkg&&echo done" } }`, "package.json", scoped).length).toBe(1);
    expect(scan(`{ "scripts": { "a": "npx @scope/pkg;echo done" } }`, "package.json", scoped).length).toBe(1);
    expect(scan(`{ "scripts": { "a": "npx @scope/pkg|grep x" } }`, "package.json", scoped).length).toBe(1);
    expect(scan(`{ "scripts": { "a": "npx a&&npx @scope/pkg run" } }`, "package.json", scoped).length).toBe(1);
  });
  test("wrapper invocations match (deliberate permissive runner boundary)", () => {
    expect(scan(`{ "scripts": { "a": "sudo npx expo start" } }`, "package.json").length).toBe(1);
  });
  test("a flag/assignment VALUE is not a bare invocation", () => {
    expect(scan(`{ "scripts": { "a": "tool --flag=expo" } }`, "package.json")).toEqual([]);
    expect(scan(`{ "scripts": { "a": "MODE=expo tool run" } }`, "package.json")).toEqual([]);
  });
});

describe("scanCli — shell / Dockerfile / workflow / Makefile", () => {
  test("shell file: context 'shell', physical line", () => {
    const sh = `#!/bin/bash\nnpm ci\nexpo export --platform web\n`;
    expect(scan(sh, "scripts/build.sh")).toEqual([{ context: "shell", line: 3 }]);
  });
  test("Dockerfile: context tracks the FROM ... AS stage", () => {
    const df = `FROM node:20 AS build\nRUN npm ci\nRUN npx expo export\nFROM nginx AS serve\nCOPY --from=build /app /usr/share/nginx/html\n`;
    const rows = scan(df, "Dockerfile");
    expect(rows).toEqual([{ context: "stage:build", line: 3 }]);
  });
  test("workflow: file-kind context with the physical line", () => {
    const wf = `jobs:\n  build:\n    steps:\n      - run: npx expo export\n`;
    expect(scan(wf, ".github/workflows/ci.yml")).toEqual([{ context: "workflow", line: 4 }]);
  });
  test("a NESTED workflow path is still scanned (§5.G '.github/workflows/**')", () => {
    expect(classifyFile(".github/workflows/reusable/ci.yml")).toBe("workflow");
    expect(scan(`- run: npx expo export\n`, ".github/workflows/reusable/ci.yml")).toEqual([{ context: "workflow", line: 1 }]);
  });
  test("Makefile recipe line matches", () => {
    const mk = `build:\n\texpo export\n`;
    expect(scan(mk, "Makefile")).toEqual([{ context: "makefile", line: 2 }]);
  });
});

describe("deriveTerms — precompiled bare matchers (§7)", () => {
  test("bareMatchers is compiled once per exec/bare term and matches like bareTokenRegex", () => {
    const d = deriveTerms({ packageName: "expo", name: "expo", binNames: ["expo-cli"] });
    expect(d.bareMatchers.length).toBe(d.execAndBareTerms.size); // one per exec/bare term
    expect(d.bareMatchers.some((re) => re.test("expo start"))).toBe(true);
    expect(d.bareMatchers.some((re) => re.test("expo-cli run"))).toBe(true);
    // boundary-aware: a longer word must NOT match (behaviour-identical to bareTokenRegex)
    expect(d.bareMatchers.some((re) => re.test("run-export-thing"))).toBe(false);
  });
  test("a scoped name contributes only its bins as bare matchers (never the scoped specifier)", () => {
    const d = deriveTerms({ packageName: "@scope/pkg", name: "@scope/pkg", binNames: ["mycli"] });
    expect(d.bareMatchers.length).toBe(1); // just the bin
    expect(d.bareMatchers[0]!.test("mycli run")).toBe(true);
  });
  test("a reused precompiled matcher is stateless across commands (no /g lastIndex leak)", () => {
    const d = deriveTerms({ packageName: "expo", name: "expo", binNames: [] });
    const re = d.bareMatchers[0]!;
    expect(re.test("expo a")).toBe(true);
    expect(re.test("expo a")).toBe(true); // second call: same result, no lastIndex advance
  });
});

describe("scanCli — determinism + shape", () => {
  test("two scripts invoking the package on distinct keys are distinct rows (context in identity)", () => {
    const p = `{ "scripts": { "a": "expo build", "b": "expo test" } }`;
    const rows = scanCli(p, ctx("package.json"), expo);
    expect(rows.map((r) => r.context).sort()).toEqual(["scripts.a", "scripts.b"]);
  });
  test("row shape: cli permalink + trimmed snippet", () => {
    const rows = scanCli(`build:\n\texpo export\n`, ctx("Makefile"), expo);
    expect(rows[0]!.permalink).toBe("https://github.com/org-a/repo/blob/abc123def/Makefile#L2");
    expect(rows[0]!.snippet).toBe("expo export");
  });
  test("no term sets → no rows; unrelated file kind → no rows", () => {
    expect(scanCli(`expo export`, ctx("Makefile"), [])).toEqual([]);
    expect(scanCli(`import x from "expo"`, ctx("src/a.ts"), expo)).toEqual([]);
  });
});
