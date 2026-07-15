// discovery.ts — the shared outcome type for a discovery scope (branch allow/deny §9). A scope's
// discovery either SUCCEEDS (with a possibly-EMPTY item list) or FAILS (throttled or permanent). This
// discriminates "discovered, genuinely empty" from "discovery failed" — a distinction the pre-feature
// code lost by returning `[]` for both. Two consumers branch on `ok`:
//   - T7 (policy-warning suppression): only a SUCCESSFUL scope counts toward "any repo discovered", and
//     "unmatched pattern" warnings are suppressed entirely when zero scopes succeeded.
//   - T11 (schema-neutral reconciliation): NEVER prune a FAILED scope's rows (a throttle/permission
//     failure must not be read as "these branches no longer exist").
// A FAILED outcome NEVER carries partial items — that is load-bearing for T11's destructive safety.
export type DiscoveryOutcome<T> =
  | { readonly ok: true; readonly items: readonly T[] }
  | { readonly ok: false; readonly reason: "throttled" | "failed" };

export const discovered = <T>(items: readonly T[]): DiscoveryOutcome<T> => ({ ok: true, items });
// `reason` preserves the existing operational split: a throttle is TRANSIENT (requeue observability, no
// errors row — the next run re-discovers); a permanent failure records an errors row. The producer logs
// and records BEFORE returning, so the outcome needs no message/cause.
export const discoveryFailed = (reason: "throttled" | "failed"): DiscoveryOutcome<never> => ({ ok: false, reason });
