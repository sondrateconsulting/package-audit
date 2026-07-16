// Test-only worker: runs scanCli on a space-padded Dockerfile line OFF the main thread so that a
// ReDoS regression (a re-introduced backtracking `FROM…AS` regex in dockerfileUnits) hangs THIS
// worker instead of the whole test runner. The parent (cliScanner.test.ts) races a deadline and
// terminate()s a hung worker, turning a would-be unbounded hang into a bounded, deterministic test
// failure. On any OTHER failure the worker catches it and reports the real cause back (see
// WorkerReply) so the parent rejects with it immediately instead of misreading it as a ReDoS
// timeout. Named without `.test.` so Bun does not execute it as a test file.
import { scanCli } from "./cliScanner.ts";

// The tagged reply the parent test awaits: the parsed rows on success, or the error message so a
// fixture/runtime failure surfaces as itself rather than as a misleading 5s ReDoS timeout.
export type WorkerReply =
  | { ok: true; rows: { context: string; line: number }[] }
  | { ok: false; error: string };

// Minimal local shape for the worker global — avoids depending on ambient DOM/WebWorker lib types
// (tsconfig `lib` is ESNext-only). Bun supplies the runtime `self`/`postMessage` at execution.
declare const self: {
  onmessage: ((event: { data: number }) => void) | null;
  postMessage: (message: WorkerReply) => void;
};

self.onmessage = (event) => {
  const spaces = event.data;
  try {
    const content = "FROM " + " ".repeat(spaces) + "X\nRUN expo export\n";
    const rows = scanCli(
      content,
      {
        githubHost: "github.com",
        organization: "o",
        repository: "r",
        branch: "main",
        commitSha: "abc123def", // must be a hex SHA — buildPermalink rejects a branch-like value
        filePath: "Dockerfile",
      },
      [{ packageName: "expo", name: "expo", binNames: [] }],
    ).map((row) => ({ context: row.context, line: row.lineNumber }));
    self.postMessage({ ok: true, rows });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
