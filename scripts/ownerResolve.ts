// ownerResolve.ts — the pure §1 effective-owner-resolution algorithm. Given the CONFIGURED owner
// fields plus the DISCOVERED org memberships and personal login (both fetched by orchestrate.ts
// through the gh wrapper), compute the effective owner list and its source. No I/O — the network
// side (gh user/orgs, gh api user) lives in orchestrate.ts so this stays unit-testable.

export class EmptyOwnersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyOwnersError";
  }
}

export type OwnersSource = "configured" | "discovered";

export interface OwnerResolveInput {
  // From config (§1): null/omitted = DISCOVER; an array (incl. []) = CONFIGURED allowlist.
  organizations: string[] | null;
  excludeOrganizations: string[];
  includePersonalNamespace: boolean;
  // Fetched by orchestrate.ts BEFORE calling this (discovery re-runs every invocation, §1):
  discoveredOrgs: string[]; // gh user/orgs .login (empty when configured mode / none visible)
  personalLogin: string | null; // gh api user --jq .login (null when not fetched/needed)
}

export interface OwnerResolveResult {
  owners: string[]; // effective list, de-duplicated, sorted deterministically
  source: OwnersSource;
}

// §1 steps 1-4: base set (allowlist OR discovery) → append personal login in BOTH modes →
// subtract excludes in BOTH modes → dedupe + sort → empty-fail-fast with remediation.
export function resolveEffectiveOwners(input: OwnerResolveInput): OwnerResolveResult {
  const configured = input.organizations !== null;
  const base = configured ? input.organizations! : input.discoveredOrgs;
  const source: OwnersSource = configured ? "configured" : "discovered";

  const set = new Set(base);
  if (input.includePersonalNamespace) {
    if (input.personalLogin === null || input.personalLogin === "")
      throw new EmptyOwnersError("includePersonalNamespace is true but the personal login could not be resolved (gh api user)");
    set.add(input.personalLogin);
  }
  for (const ex of input.excludeOrganizations) set.delete(ex);

  const owners = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (owners.length === 0) throw new EmptyOwnersError(emptyRemediation(input, source));
  return { owners, source };
}

// Actionable fail-fast message (§1 step 4): name the LIKELY causes given the mode.
function emptyRemediation(input: OwnerResolveInput, source: OwnersSource): string {
  const hints: string[] = [];
  if (source === "discovered") {
    hints.push("no discoverable org memberships (a token may be missing the `read:org` scope or SSO authorization)");
    if (!input.includePersonalNamespace) hints.push("set `includePersonalNamespace: true` to scan your own repos");
  } else {
    hints.push("the configured `organizations` allowlist resolved to nothing");
    if (!input.includePersonalNamespace) hints.push("an explicit `organizations: []` needs `includePersonalNamespace: true` to have any owner");
  }
  if (input.excludeOrganizations.length > 0) hints.push("`excludeOrganizations` may be removing every owner");
  return `effective owner list is EMPTY (${source} mode). Likely causes: ${hints.join("; ")}.`;
}
