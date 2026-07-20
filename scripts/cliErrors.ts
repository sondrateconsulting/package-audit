// cliErrors.ts — shared fatal-error rendering for the CLI entrypoints (§8). KNOWN operator-facing
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
