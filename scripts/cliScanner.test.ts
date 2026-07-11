import { expect, test, describe } from "bun:test";
import { scanCli, deriveTerms, classifyFile, type CliTermSet, type CliScanContext } from "./cliScanner.ts";
import type { WorkerReply } from "./cliScannerRedosWorker.ts";

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

describe("scanCli — Dockerfile FROM…AS stage parsing (linear, ReDoS-safe)", () => {
  // Regression guard for CWE-1333. The previous parser used
  //   /^\s*FROM\s+.*?\s+AS\s+([A-Za-z0-9_.-]+)/i
  // whose `\s+ .*? \s+` places three space-matching quantifiers back-to-back before a literal `AS`
  // that can fail; on a `FROM` line followed by a long run of spaces the engine explores O(N³)
  // partitions of that run before declaring failure. `.exec` is synchronous, so one such line —
  // landable by any contributor in a scanned Dockerfile — blocks the single JS thread and hangs the
  // whole audit run. Timings for the old regex: 1k spaces ≈ 0.2s, 2k ≈ 1.6s, 4k ≈ 14s (×8 per
  // doubling → 100k spaces ≈ hours). The linear tokenizer resolves 100k spaces in single-digit ms.
  //
  // We run scanCli in a Worker so a re-introduced backtracking regex hangs the WORKER, not the test
  // runner: the parent races a 5s deadline and terminate()s a hung worker, turning a would-be
  // unbounded hang into a bounded, deterministic failure. A synchronous regex cannot be interrupted
  // by Bun's per-test timeout, and the repo-wide single-chokepoint guard (github.test.ts) forbids
  // process-spawning APIs, so a Worker (a thread the parent can terminate) is the fit.
  //
  // Three outcomes, all bounded: the worker posts a tagged reply on success/scanCli-throw (surfaced
  // immediately with its real cause), `onerror` catches a worker that fails to load/run, and the 5s
  // deadline catches an actual ReDoS hang — so a NON-ReDoS failure never masquerades as a timeout.
  test("a space-padded FROM line cannot hang the scanner (ReDoS regression guard)", async () => {
    const worker = new Worker(new URL("./cliScannerRedosWorker.ts", import.meta.url).href);
    try {
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("scanCli did not finish in 5s — a cubic-time FROM…AS regression is hanging")),
          5000,
        );
        const settle = (action: () => void) => {
          clearTimeout(timer);
          action();
        };
        worker.onmessage = (event) => settle(() => resolve(event.data as WorkerReply));
        worker.onerror = (event) =>
          settle(() => reject(new Error(`worker failed to run: ${(event as { message?: string }).message ?? String(event)}`)));
        worker.postMessage(100_000); // 100k spaces
      });
      if (!reply.ok) throw new Error(`scanCli threw inside the worker: ${reply.error}`);
      // the padded FROM has no `AS` token → it is a bare FROM (stage index 0); the expo line inherits it
      expect(reply.rows).toEqual([{ context: "stage:0", line: 2 }]);
    } finally {
      worker.terminate();
    }
  }, 15_000);

  test("named stages, a later stage, and a trailing bare FROM all track correctly", () => {
    const df =
      [
        "FROM node:20 AS build", //         named → stage:build
        "RUN expo a", //                    line 2 → stage:build
        "COPY --from=build /a /b", //       non-FROM line does NOT transition the stage
        "FROM nginx AS serve", //           named → stage:serve
        "RUN expo b", //                    line 5 → stage:serve
        "FROM alpine", //                   bare  → stage index 2 (two prior FROMs)
        "RUN expo c", //                    line 7 → stage:2
      ].join("\n") + "\n";
    expect(scan(df, "Dockerfile")).toEqual([
      { context: "stage:build", line: 2 },
      { context: "stage:serve", line: 5 },
      { context: "stage:2", line: 7 },
    ]);
  });

  test("FROM/AS keywords are case-insensitive", () => {
    expect(scan("from ubuntu as base\nRUN expo x\n", "Dockerfile")).toEqual([
      { context: "stage:base", line: 2 },
    ]);
  });

  test("flags before the image (--platform) do not confuse the AS parser", () => {
    expect(scan("FROM --platform=linux/amd64 node:20 AS builder\nRUN expo x\n", "Dockerfile")).toEqual([
      { context: "stage:builder", line: 2 },
    ]);
  });

  test("irregular inner whitespace (extra spaces + tabs) still parses the stage name", () => {
    expect(scan("FROM   node:20 \t AS   \t build\nRUN expo x\n", "Dockerfile")).toEqual([
      { context: "stage:build", line: 2 },
    ]);
  });

  test("a leading bare FROM yields stage index 0", () => {
    expect(scan("FROM alpine\nRUN expo x\n", "Dockerfile")).toEqual([{ context: "stage:0", line: 2 }]);
  });

  test("an image literally named `as` is not mistaken for the AS keyword", () => {
    // the AS keyword can only appear AFTER a real image token; the image `as` must be skipped
    expect(scan("FROM as AS build\nRUN expo x\n", "Dockerfile")).toEqual([
      { context: "stage:build", line: 2 },
    ]);
  });

  test("a FROM…AS with no trailing stage name falls back to a bare (indexed) stage", () => {
    // line 1 → stage:named (index→1); line 2 `FROM x AS` has no name → bare FROM → stage:1
    const df = "FROM base AS named\nFROM x AS\nRUN expo z\n";
    expect(scan(df, "Dockerfile")).toEqual([{ context: "stage:1", line: 3 }]);
  });

  test("an AS whose next token is not a valid stage name is skipped for the next AS", () => {
    expect(scan("FROM x AS @bad AS good\nRUN expo z\n", "Dockerfile")).toEqual([
      { context: "stage:good", line: 2 },
    ]);
  });

  test("the first valid AS wins", () => {
    expect(scan("FROM x AS first AS second\nRUN expo z\n", "Dockerfile")).toEqual([
      { context: "stage:first", line: 2 },
    ]);
  });

  test("a stage name keeps only its leading valid chars (drops a trailing `:tag`)", () => {
    expect(scan("FROM x AS build:latest\nRUN expo z\n", "Dockerfile")).toEqual([
      { context: "stage:build", line: 2 },
    ]);
  });

  test("a comment line does not transition the stage", () => {
    const df = "FROM base AS keep\n# FROM foo AS changed\nRUN expo z\n";
    expect(scan(df, "Dockerfile")).toEqual([{ context: "stage:keep", line: 3 }]);
  });

  test("a trailing-space bare FROM still advances the stage index", () => {
    // line 1 `FROM ` (trailing space, no image) is a bare FROM → stage:0, index→1;
    // line 2 `FROM scratch` is a bare FROM → stage:1
    const df = "FROM \nFROM scratch\nRUN expo z\n";
    expect(scan(df, "Dockerfile")).toEqual([{ context: "stage:1", line: 3 }]);
  });

  test("an image literally named `as` under a flag matches the old regex (stage:AS, not Docker semantics)", () => {
    // Both the OLD case-insensitive regex and the tokenizer treat the lowercase image `as` as the AS
    // keyword, so the stage becomes `AS`. This asserts behavior-EQUIVALENCE with the old parser, not
    // Docker-correctness (Docker would read the stage as `build`). Confirmed by differential testing:
    // old and new both yield stage:AS here.
    expect(scan("FROM --platform=linux/amd64 as AS build\nRUN expo x\n", "Dockerfile")).toEqual([
      { context: "stage:AS", line: 2 },
    ]);
  });

  test("a malformed no-image `FROM  AS x` is the sole documented divergence (bare stage, not stage:x)", () => {
    // The old two-`\s+` regex read this malformed line (no image between FROM and AS) as `stage:x`;
    // tokenizing normalizes whitespace and treats it as a bare FROM → `stage:0`. A real Dockerfile
    // always has an image, so this input never occurs in practice. This is the ONLY input where the
    // tokenizer intentionally differs from the old regex (verified over 40k differential inputs).
    expect(scan("FROM  AS x\nRUN expo z\n", "Dockerfile")).toEqual([{ context: "stage:0", line: 2 }]);
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
