// benchGrammar.ts — the PROPOSED readOnlyGuard grammars for ADR-0001's benchmark drivers
// (resolution plan §3.2/§4.1). This module is the benchmark's standalone shipping vehicle for
// the grammar work Option 2c (and a faithful Option 2a) would add to readOnlyGuard.ts — the
// production guard is deliberately untouched until an ADR adopts these (plan §7). The bench
// asserts every EVALUATED-TRANSPORT git argv against this module before spawning:
//
//   1. clone shape "checkout"     — the exact production tuple (readOnlyGuard.ts's grammar);
//   2. clone shape "no-checkout"  — the production tuple + `--no-checkout`, a SECOND required
//      tuple: the guard's clone options are mandatory-exactly-once (readOnlyGuard.ts:287), so
//      the flag cannot join a shared boolean set without breaking shape 1's "exactly once";
//   3. `ls-tree -r -z -l --full-tree <rev>` — one exact tuple, rev = HEAD or a full object id;
//   4. `cat-file --batch` — one exact two-token tuple, so `--textconv`/`--filters` (and every
//      other option) are STRUCTURALLY absent, not denylisted;
//   5. `rev-parse HEAD|FETCH_HEAD` — the coherence check; production already allowlists
//      rev-parse with bare positionals, and the bench pins the positional to the two revs the
//      drivers actually assert.
//
// SHA-pinned acquisition scaffolding (init/remote add/fetch/checkout --detach) is bench
// scaffolding, NOT proposed production grammar — its exact argv tuples are pinned in
// bench-config.json and asserted by the spawn module's scaffolding lane, never here (§4.1).
//
// Style mirrors readOnlyGuard.ts on purpose (raw-argv parsing, arity-aware value flags,
// fail-closed deny) so a future adoption diff is a transplant, not a rewrite.

export class BenchGrammarViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchGrammarViolation";
  }
}
const deny = (msg: string): never => {
  throw new BenchGrammarViolation(`BENCH GRAMMAR VIOLATION: ${msg}`);
};

// The two git object formats the repository-aware validations key on — matching the dual
// format github.ts already accepts for API oids (a hardcoded 40-hex would regress SHA-256
// repositories; plan §3.1 "Object-format awareness").
export type BenchObjectFormat = "sha1" | "sha256";
export const OID_LENGTH: Record<BenchObjectFormat, number> = { sha1: 40, sha256: 64 };
export function isFullOid(value: string, format: BenchObjectFormat): boolean {
  const n = OID_LENGTH[format];
  return value.length === n && /^[0-9a-f]+$/.test(value);
}

// clone options, split by arity exactly as the production grammar splits them
// (readOnlyGuard.ts): VALUE flags consume the following token, BOOL flags stand alone.
const CLONE_VALUE = new Set(["--depth", "--branch", "--template"]);
const CLONE_BOOL_SHARED = new Set(["--single-branch", "--no-tags", "--no-recurse-submodules"]);
const NO_CHECKOUT = "--no-checkout";

export type CloneShape = "checkout" | "no-checkout";

// The verbs this proposed grammar covers. Everything else — including every scaffolding verb —
// is denied here; scaffolding argv goes through the spawn module's config-pinned lane instead.
const PROPOSED_VERBS = new Set(["clone", "ls-tree", "cat-file", "rev-parse"]);

export interface ProposedGitAssertOptions {
  objectFormat: BenchObjectFormat;
  // REQUIRED for clone: the caller declares which of the two tuples it intends, so a driver
  // can never drift into the other shape by accident (T2a asserts "checkout", T2c asserts
  // "no-checkout"; T0/T1's C4 fallback asserts "checkout").
  cloneShape?: CloneShape;
}

// Assert one evaluated-transport git argv against the proposed grammars. Throws
// BenchGrammarViolation on anything outside them (fail closed, same posture as the guard).
export function assertProposedReadOnlyGit(rawArgs: string[], opts: ProposedGitAssertOptions): void {
  if (rawArgs.length === 0) deny("git with no subcommand");
  const verb = rawArgs[0]!;
  // a pre-verb global (`git -c x clone`, `git --no-replace-objects …`) lands in the verb slot
  // and is denied — the production guard treats it identically (readOnlyGuard.ts:225), which is
  // exactly why the no-replace guarantee travels as GIT_NO_REPLACE_OBJECTS in the env instead.
  if (!PROPOSED_VERBS.has(verb)) deny(`git ${verb}`);
  // config-injection short options on ANY verb, incl. attached forms — mirror of the guard.
  for (const a of rawArgs) if (/^-c/.test(a) || /^-u/.test(a)) deny(`git option ${a}`);

  if (verb === "cat-file") {
    // ONE exact two-token tuple. Anything beyond it — --textconv, --filters, a rev argument,
    // -z, --batch-check — is structurally impossible, not merely denied by name.
    if (rawArgs.length !== 2 || rawArgs[1] !== "--batch")
      deny("cat-file is restricted to the exact `cat-file --batch` tuple");
    return;
  }

  if (verb === "ls-tree") {
    // ONE exact tuple: `ls-tree -r -z -l --full-tree <rev>`, rev = HEAD (production form) or a
    // full object id in the repository's format (SHA-pinned scaffolding form, plan §4.4). No
    // reordering, no abbreviations, no pathspecs — a pathspec would silently narrow the
    // enumeration the completeness gate (G2) depends on.
    const fixed = ["-r", "-z", "-l", "--full-tree"];
    if (rawArgs.length !== 6) deny("ls-tree is restricted to the exact `ls-tree -r -z -l --full-tree <rev>` tuple");
    for (let i = 0; i < fixed.length; i++) {
      if (rawArgs[i + 1] !== fixed[i]) deny(`ls-tree argv slot ${i + 1} must be ${fixed[i]}`);
    }
    const rev = rawArgs[5]!;
    if (rev !== "HEAD" && !isFullOid(rev, opts.objectFormat))
      deny(`ls-tree rev must be HEAD or a full ${opts.objectFormat} object id`);
    return;
  }

  if (verb === "rev-parse") {
    // production allowlists rev-parse with bare positionals only (no flags); the bench pins the
    // positional further to the two revs its coherence assertions actually read.
    if (rawArgs.length !== 2) deny("rev-parse takes exactly one rev");
    const rev = rawArgs[1]!;
    if (rev !== "HEAD" && rev !== "FETCH_HEAD") deny(`rev-parse rev ${rev}`);
    return;
  }

  // verb === "clone": parse the RAW argv as an exact grammar, mirroring the production parser
  // (raw preserves `--flag=value` vs `--flag value`, so a BOOL flag given a value is rejected;
  // a VALUE flag consumes the NEXT token even when that token looks like a flag).
  const shape = opts.cloneShape;
  if (shape === undefined) deny("clone assertion requires a declared cloneShape");
  const raw = rawArgs.slice(1);
  const seen: Record<string, number> = {};
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  const boolSet = new Set(CLONE_BOOL_SHARED);
  if (shape === "no-checkout") boolSet.add(NO_CHECKOUT);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      const attached = eq === -1 ? undefined : a.slice(eq + 1);
      if (CLONE_VALUE.has(name)) {
        seen[name] = (seen[name] ?? 0) + 1;
        if (attached !== undefined) values[name] = attached;
        else { values[name] = raw[i + 1] ?? ""; i++; }
      } else if (boolSet.has(name)) {
        if (attached !== undefined) deny(`git clone ${name} takes no value`);
        seen[name] = (seen[name] ?? 0) + 1;
      } else {
        // `--no-checkout` under the "checkout" shape lands here: shape 1 has no such option,
        // which is precisely the "second required tuple, not a shared flag" structure.
        deny(`git clone option ${a}`);
      }
    } else if (a.startsWith("-") && a.length > 1) {
      deny(`git clone option ${a}`); // no short flags in either hardened tuple
    } else {
      positionals.push(a); // url or dest
    }
  }
  // every option of the declared tuple is REQUIRED, exactly once — including --no-checkout in
  // shape 2 (mandatory-exactly-once, never optional; readOnlyGuard.ts:287's discipline).
  for (const f of [...CLONE_VALUE, ...boolSet]) {
    if ((seen[f] ?? 0) === 0) deny(`git clone missing hardening ${f}`);
    if ((seen[f] ?? 0) > 1) deny(`git clone duplicate ${f}`);
  }
  if ((values["--depth"] ?? "") !== "1") deny("git clone --depth must be 1 (shallow)");
  const branch = values["--branch"] ?? "";
  if (branch === "" || branch.startsWith("-")) deny("git clone --branch must have a concrete value");
  if ((values["--template"] ?? "x") !== "") deny("git clone --template must be empty");
  if (positionals.length !== 2) deny(`git clone expects <url> <dest>, got ${positionals.length} positionals`);
}
