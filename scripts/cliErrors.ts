// cliErrors.ts — shared fatal-error rendering and exit for the CLI entrypoints (§8). KNOWN operator-facing
// failures (bad flags, invalid config, failed preflight, exhausted throttles, guard violations, …)
// print their message WITHOUT a stack trace — a stack makes an expected condition read as a
// crash. Most of these messages carry their remediation directly (auth/SSO/config/preflight/
// throttle); the rest are concise diagnostics — e.g. GithubApiError's HTTP/parse failures name
// the status and endpoint — where a stack would add noise, not action. Anything else is a
// genuine bug and keeps the full stack for the report.

// Matched by error.name (survives module boundaries and subclassing quirks). Every class here is
// operator-facing by design: an expected failure of the run's preconditions or environment,
// rendered message-only.
export const KNOWN_OPERATOR_ERRORS: ReadonlySet<string> = new Set([
  "ArgsError", // args.ts
  "TuiActivationError", // tui/activation.ts — --ui demanded in an ineligible environment (PROMPT-TUI §U1)
  "ConfigError", // config.ts
  "JsoncError", // jsonc.ts (config/bun.lock parsing)
  "YamlLiteError", // yamlLite.ts (pnpm-workspace/lockfile parsing)
  "PreflightError", // preflight.ts (§2)
  "EmptyOwnersError", // ownerResolve.ts (§1 empty-effective-list fail-fast)
  "DbError", // db.ts
  "GithubApiError", // github.ts
  "ThrottleExhausted", // github.ts (§4)
  "IntrospectionError", // apiSurface.ts (§5.E)
  "ReadOnlyViolation", // readOnlyGuard.ts (§0/§6)
  "ArtifactWriteError", // artifactWrite.ts (operator-facing ONLY: artifact-name collisions —
  //                       config-triggerable when two tracked packages sanitize/alias to one
  //                       dossier filename — and a non-real xray/ dir (symlink or non-directory); lifecycle bugs there
  //                       are plain Errors and keep their stacks)
  "PolicyMatchError", // branchPolicy.ts — a branch policy glob failed to evaluate, in one of two
  //                     fail-closed ways: (a) a compiled matcher threw at .match() (or construction)
  //                     time — a pattern Bun.Glob accepted but cannot evaluate; none is currently
  //                     known to do this, so the class is insurance; (b) the write chokepoint
  //                     (db.ts) found a stored excluded-by-deny row whose policy_matched_pattern does
  //                     NOT match the branch it claims to have excluded (write-time attribution
  //                     coherence). Both are operator-actionable; the run driver fails the run and
  //                     rethrows it UNCHANGED (unlike BranchPolicyError, which loadConfig always
  //                     converts to ConfigError).
  "RepoPolicyMatchError", // repositoryPolicy.ts — an excludeRepositories glob threw at .match() time
  //                         (fail-closed: a throw is FATAL, never a `false` that would silently scan a
  //                         denylisted repo). None is known to do this on the exercised Bun, so the
  //                         class is insurance. The run driver fails the run and rethrows it UNCHANGED
  //                         (unlike RepositoryPolicyError, which loadConfig always converts to ConfigError).
]);

export function isKnownOperatorError(e: unknown): e is Error {
  return (
    e instanceof Error &&
    // message-prefix fallback: a guard violation re-wrapped into a plain Error stays known.
    (KNOWN_OPERATOR_ERRORS.has(e.name) || e.message.startsWith("READ-ONLY VIOLATION:"))
  );
}

// Render a fatal error for stderr. `usage` is the entrypoint's one-line usage synopsis — appended
// only for argument errors, where "what are my options" is the actual question; other known
// failures get the message alone.
export function renderFatal(e: unknown, opts: { command: string; usage: string }): string {
  if (isKnownOperatorError(e)) {
    const usageHint = e.name === "ArgsError" ? `${opts.usage}\nRun with --help for details.\n` : "";
    return `${opts.command} failed: ${e.message}\n${usageHint}`;
  }
  const err = e instanceof Error ? e : new Error(String(e));
  return `${opts.command} failed (unexpected): ${err.stack ?? err.message}\n`;
}

// ---- the fatal exit -------------------------------------------------------------------------
// The audit entrypoints (orchestrate, report, export, compare) hand main()'s rejection here, and
// this never hard-exits on the spot: a hard exit (process.exit) discards whatever the runtime
// still buffers for a piped stdout or stderr. Measured on macOS: of 2,001 JSONL lines written
// into a slow consumer, a hard exit delivered 284 whole lines on both Bun 1.4.3 and Node 24 — on
// Bun exactly one 64 KiB pipe buffer, so a 285th line arrived cut mid-way — while a natural exit
// delivered all 2,001 on both (stderr behaved the same on both: 299 of 2,001 versus all). On Bun
// 1.4.3, process.stdout reported writableLength 0 and no pending drain while those bytes were
// still unflushed, so waiting for the stream's 'drain' cannot close that gap there. Instead the
// exit code is set and control returns; the event loop stays alive until both streams have
// flushed (the natural exit measured above), then the process exits 1 on its own. The backstop
// bounds that wait: it is unref'd (it never holds the process open itself) and hard-exits 1 only
// if the loop has not emptied within FATAL_DRAIN_DEADLINE_MS — a consumer that stopped reading,
// or a handle a fatal left open. A fatal therefore ends by that deadline at the latest; a consumer
// still behind then loses the unflushed tail.
export const FATAL_DRAIN_DEADLINE_MS = 10_000;

// The process surface exitFatal drives — injected so tests can observe it without exiting.
export interface FatalExitHost {
  readonly stderr: { write(chunk: string): unknown };
  setExitCode(code: number): void;
  exit(code: number): void;
  armBackstop(fire: () => void, ms: number): void; // must not hold the process open
}

// The production backstop; returns the timer so a test can confirm it is unref'd.
export function armUnrefBackstop(fire: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return timer;
}

// The real process; exported only so a test can pin its wiring.
export const PROCESS_FATAL_HOST: FatalExitHost = {
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => process.exit(code),
  armBackstop: armUnrefBackstop,
};

export function exitFatal(e: unknown, opts: { command: string; usage: string }, host: FatalExitHost = PROCESS_FATAL_HOST): void {
  host.stderr.write(renderFatal(e, opts));
  host.setExitCode(1);
  host.armBackstop(() => host.exit(1), FATAL_DRAIN_DEADLINE_MS);
}
