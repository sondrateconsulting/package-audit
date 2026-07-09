// cliErrors.ts — shared fatal-error rendering for the two entrypoints (§8). KNOWN operator-facing
// failures (bad flags, invalid config, failed preflight, exhausted throttles, guard violations, …)
// print their actionable message WITHOUT a stack trace — the message already carries the
// remediation, and a stack makes an expected condition read as a crash. Anything else is a
// genuine bug and keeps the full stack for the report.

// Matched by error.name (survives module boundaries and subclassing quirks). Every class here is
// thrown with a human-actionable message by design.
export const KNOWN_OPERATOR_ERRORS: ReadonlySet<string> = new Set([
  "ArgsError", // args.ts
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
// failures already end with their remediation and get the message alone.
export function renderFatal(e: unknown, opts: { command: string; usage: string }): string {
  if (isKnownOperatorError(e)) {
    const usageHint = e.name === "ArgsError" ? `${opts.usage}\nRun with --help for details.\n` : "";
    return `${opts.command} failed: ${e.message}\n${usageHint}`;
  }
  const err = e instanceof Error ? e : new Error(String(e));
  return `${opts.command} failed (unexpected): ${err.stack ?? err.message}\n`;
}
