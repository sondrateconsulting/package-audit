# Plan: implement ADR-0001 Option 2c (T2c) — per-unit no-checkout clone, canonical-object reads via guarded `cat-file`

Status: draft for the pre-implementation codex loop (process requirement 1; ≤5 iterations,
outcome recorded in §9). Implementation follows only after rvo's decision batch (§5).

Governing texts, in order: the ADR's Decision Outcome (specified constraints + residual risks)
and Confirmation (9 post-implementation checks) in
[0001-file-content-acquisition-strategy.md](../adrs/0001-file-content-acquisition-strategy.md);
resolution-plan [§3.1/§3.2](adr-0001-disagreements-resolution.md). This plan adds no
requirements to that bill; it maps the bill onto this repository.

## 1. Scope and non-goals

Replace the per-file REST content path for every branch unit with Option 2c's production shape:
no-checkout clone → head coherence → local `ls-tree` enumeration → unit-lived `cat-file --batch`
child serving the existing pull-style `ReadFile` seam, symlinks mode-routed to the REST
dereference fallback under a per-unit budget. The per-unit REST tree request and the
truncated-tree checkout-clone fallback retire.

Non-goals: raw-byte consumers (the seam stays a string contract); OID-keyed cross-run caching
(Option 3 — rejected for this path by the ADR); discovery changes (repo/branch listing is
untouched); any bench re-run (no §8 amendment in this PR; the live frozen-surface digest may
move because non-test `scripts/*` files change — disclosed, gate-refused by design).

## 2. Module map

The repo-wide spawn scan pins `scripts/github.ts` to **exactly one** textual process-launch
site, and README/PROMPT/EXPORTS carry that claim. The design keeps the count at one by
parameterizing the existing launch primitive rather than adding a second call.

| Module | Change |
|---|---|
| `readOnlyGuard.ts` | The three new grammars inside `assertReadOnlyGit` (§3.1 below); the "cat-file excluded by name" comment block rewritten with the code. |
| `gitFrame.ts` (new) | Production home of the framed parsers: `BatchFrameParser`, `parseLsTreeZ`, `ByteRing` (ported per §4), plus `gitBlobOid(body, format)` (`blob <len>\0<body>` via `Bun.CryptoHasher`, sha1/sha256) and `seamDecode` (UTF-8-with-replacement). Pure; no process machinery. |
| `contentStore.ts` (new) | `UnitContentStore`: the ls-tree index (path → {mode, oid, size}), the OID-only stdin writer, the child manager (lazy spawn, per-read deadline, single respawn, poisoning, ordered teardown — adapted from `benchSpawn.ts`'s review-hardened `BatchChild`), mode routing (symlink → injected REST fallback), the per-unit fallback budget, and the separated counters. Takes injected capabilities (launch, one-shot byte spawn, REST read, child-pool permit) so it holds no spawn surface itself. |
| `github.ts` | (a) the single `Bun.spawn` site gains a stdin-mode parameter and a structural `LaunchedChild` return used by two consumers: the existing one-shot UTF-8 path (unchanged behavior) and the new byte/interactive paths; (b) `gitBytes(args, cwd)` — one-shot guarded byte-capture spawn (for `ls-tree`; the current string path's irreversible decode would destroy the evidence the parser fails closed on); (c) `launchBatchChild(cwd)` — guarded (`assertSpawnAllowed` + `assertReadOnlyGit(["cat-file","--batch"])` + cwd containment), env-built, NOT semaphore-held (children draw from the child pool); (d) `cloneNoCheckout(org, repo, branch, pinnedOid)` — production argv + `--no-checkout`, bounded retry (§5 Q1), `rev-parse HEAD` must equal `pinnedOid` else fail closed; (e) `buildGitEnv` sets `GIT_NO_REPLACE_OBJECTS=1` unconditionally — for **every** git spawn, not just the child: `rev-parse`/`ls-tree` running with replace refs while `cat-file` runs without them would let the coherence check and the enumeration disagree with the reads; (f) the child permit pool (a second `Semaphore`; size §5 Q4); (g) the owned temp sweep (§5 Q2); (h) the per-repo clone-transport gate (§3.9 pacing). |
| `orchestrate.ts` | `processUnit` default path rewired: cloneNoCheckout → store open (ls-tree) → entries from the index → store reader → scanUnit → ordered teardown in `finally` (dispose child → delete clone → release permit). Abort threading: `branchAbort` reaches `processUnit`; on abort the store poisons the in-flight read and the unit fails through the same ordered teardown (§3.1's "kill-escalation on unit end or abort" — ratified, not a new decision). The truncated-tree branch, `walkClone`, `cloneReader` retire per §5 Q3. `apiReader`'s REST read survives as the symlink fallback lane (404 → null parity preserved). |
| `unitPipeline.ts` | No behavioral change expected: `TreeEntry.size` is now the canonical ls-tree size, so the existing 2 MiB gate reads canonical sizes by construction; manifests/lockfiles stay ungated. `MAX_SCAN_BYTES` export + CI mirror untouched. |
| `log.ts` + vocab | One new per-unit JSONL event carrying the separated counters (name TBD, e.g. `content-transport`); the log-vocabulary pin and README's event table update together. |
| `cliErrors.test.ts` | New error classes join `KNOWN_OPERATOR_ERRORS` or the exclusion list with in-place rationale (unit-scoped scan failures are not operator errors). |
| `github.test.ts` | Wrapper-discipline counts updated (`assertSpawnAllowed` 4 → 6: + `gitBytes`, + `launchBatchChild`); the spawn-site scan itself needs **no** allowlist change (count stays `bun: 1`). |

Explicitly out of the diff: `db.ts` (no schema change; tree-cache rows simply stop being
written), `config.ts` (no new keys — `config_hash` untouched, resume state preserved),
`ratification.json` (no §8 amendment; never touched).

## 3. Design detail against the nine Confirmation checks

### 3.1 Guard grammars (check 1)

`assertReadOnlyGit` grows, keeping its 1-arg signature (the wrapper test pins `guard(args)`):

- **Clone**: the grammar becomes the union of exactly two exact tuples — the existing
  checkout tuple and the same tuple + `--no-checkout` required-exactly-once. Union-of-exact
  (rather than a caller-declared shape parameter, which the bench needed to stop driver drift)
  because production's argv is constructed inside `github.ts` from an explicit parameter, so
  cross-shape drift is structurally impossible at the call sites. **Both shapes stay even
  under full cutover** (§5 Q3): the bill's specified constraint is "a second exact clone
  shape carrying `--no-checkout`" — removing the first shape would narrow beyond the bill's
  letter, so if Q3 deletes `cloneShallow` the checkout tuple is retained as deliberately
  caller-less grammar (it admits only the hardened read-only clone), stated in the PR.
- **`ls-tree`**: exactly `ls-tree -r -z -l --full-tree <rev>` with `<rev>` = `HEAD` only
  (narrowest: production's sole call site passes `HEAD` after the coherence gate; the bench's
  full-oid rev form stays bench-side in `benchGrammar.ts`). No reordering, no pathspecs (a
  pathspec would silently narrow enumeration).
- **`cat-file`**: exactly the two-token `cat-file --batch` tuple — `--textconv`/`--filters`
  (and every other option) structurally absent, not denylisted.
- Verb allowlist grows by `ls-tree` + `cat-file`; the §200-207 comment ("cat-file, log stay
  excluded entirely") is rewritten to state the new boundary: `cat-file` is admitted as ONE
  exact tuple whose stdin containment lives in the writer (check 2), and `log` stays excluded.

Accept/reject tables for all three tuples land in `readOnlyGuard.test.ts` (mirroring
`benchGrammar.test.ts`'s tables): each mandatory flag missing/duplicated/valued, abbreviations,
attached forms, pre-verb globals, `-c` injection, reordering, pathspec/extra-arg additions,
`--textconv`/`--filters`/`-z`/`--batch-check` on cat-file.

### 3.2 Stdin containment (check 2)

The writer is the ONLY thing that reaches the child's stdin: it takes the ls-tree index entry,
re-validates the OID against the repository's object format (length + lowercase hex), and
writes `<oid>\n`. Object format derives from the discovery-pinned head OID's length (40 → sha1,
64 → sha256 — the dual format `github.ts` already accepts); `parseLsTreeZ` enforces the same
format on every enumerated OID, so mixed-format listings are rejected before any read. Tests
drive each rejection: malformed hex, wrong length, uppercase, truncated, empty, a path instead
of an OID, an OID of the other format, and (parser-level) a mixed-format listing.

### 3.3 Framed reads (check 3)

`BatchFrameParser` (ported) already enforces: bounded pre-LF header (fatal + child kill via
poisoning), OID echo, `blob` type, size == ls-tree-declared size exactly, declared size ≤ the
absolute ceiling refused BEFORE the request is written, LF trailer, unsolicited-bytes fatal,
`<oid> missing LF`. The ceiling is production's existing spawn-output cap
(110 MiB — github.ts's spawn-output cap constant), so an ungated manifest can never allocate more than
today's REST path could return before the cap kill. `missing` for an enumerated OID fails the
unit closed in the store (never the seam's benign null) — bench-driver precedent. Pre-decode,
`gitBlobOid(frame.body)` must equal the enumerated OID (self-verification before the seam
decode). Streaming: memory is O(one frame) (body buffer allocated once at header acceptance).

### 3.4 Environment and coherence (check 4)

`buildGitEnv` output asserts `GIT_NO_REPLACE_OBJECTS === "1"` (unit test), and the
child-launch test asserts it in the exact env handed to the launch primitive.
`cloneNoCheckout` runs `rev-parse HEAD` (already allowlisted) and compares to the
discovery-pinned OID — mismatch fails the unit closed. **Disclosed behavior change**: the
retired checkout fallback ACCEPTED a moved branch (recorded the clone's real HEAD); the
ratified §3.1 shape refuses it (self-heals next run via re-discovery).

### 3.5 Byte-level reader checks (check 5)

Fixture-driven (CI has no network), on raw reader output, not `UnitResult`:

- M9 symlink: mode `120000`, ls-tree size 17; injected REST fallback returns a synthesized
  2,513-byte body; the reader must deliver exactly those 2,513 bytes (the dereferenced target,
  never the 17-byte link payload) and count one symlink fallback.
- Binary blob: bytes survive the frame + hash check; the seam decode is the deliberate
  UTF-8-with-replacement choice.
- Non-UTF-8 blob: delivered string equals `seamDecode(canonical bytes)` — the battery's pinned
  expectation, NOT today's REST transcode (the T0/T1 G1 evidence; deriving the check from the
  ratified standard, not incumbent behavior).
- Paths containing quote/backslash/newline/TAB: through `parseLsTreeZ` (first-TAB split) and a
  full read round-trip.
- Missing/unknown mode: fatal at parse (never treated as a regular blob).

### 3.6 Child lifecycle (check 6)

Adapted `BatchChild`: continuous stdout/stderr pumps from birth, capped stderr ring, per-read
deadline with kill-escalation, fatal poisoning on any framing violation, at most ONE respawn
per unit (second death fails the unit, first child's disposal diagnosis retained), ordered
idempotent teardown — stdin close → bounded exit await (kill-escalate) → bounded pump/disposer
join → only then clone deletion and permit release — on completion, failure, and abort alike
(the abort path threads `branchAbort` into `processUnit`). Tests: deadline expiry kills +
poisons; respawn-once; double-death fails unit with first diagnosis; teardown ordering asserted
via injected-child event order; abort mid-read rejects the read and still tears down ordered.

### 3.7 Two-pool discipline (check 7)

The child pool is a second fixed-size semaphore inside `GithubClient`, size independent of unit
fan-out (§5 Q4; ratified default: the subprocess semaphore's own size). Children never hold a
one-shot permit; a unit waiting for a child permit holds no permit of either pool. Mandatory
deadlock test: both pools at capacity 1, a live child, a symlink REST fallback — must complete.
Fan-out test: pool size 2, 4 concurrent units → never more than 2 live children.

### 3.8 Separated counters + budget (check 8)

Per-unit counters: local canonical reads, REST fallback reads by cause (today: `symlink`),
fallback-budget spend, clone-transport operations, clone retries. Surfaced as one JSONL event
per unit (vocab-pinned) and aggregated nowhere else (report schema untouched).

**The budget denominator needs a production definition (§5 Q6).** The bill's formula is
`max(20, ceil(10% of selected))`, and the bench's `selected` was the recorded read set of an
actual pipeline run (`recordSelection` drives `scanUnit` under a recording reader) — known
up-front only because the workload was pre-recorded. Production selection is content-dependent
(lockfiles read per extracted fact; source reads require a resolving tracked package), so the
true `selected` exists only after the unit finishes. Options: (a) **denominate on the
enumerable upper bound** — `eligible` = blob entries passing the pure path/size predicates
(`locateManifests` + non-binary lockfile kinds + `SCANNABLE_EXT`/`classifyFile` +
`excludeDirGlobs`/`node_modules` + the 2 MiB gate), fixed at enumeration time; since
`eligible ⊇ selected` the budget is ≥ the bill's, preserving the bound's purpose (cap per-unit
API spend, floor 20 intact) deterministically and order-independently — a DISCLOSED deviation
from the bill's literal denominator, so it goes to rvo; (b) a running ratio over reads issued
so far — rejected: order-dependent, and symlinks clustered early would fail units the
end-of-unit formula allows; (c) end-of-unit enforcement only — rejected: never trips
mid-unit, so it does not "trip and terminate as defined". Recommendation: (a). Exceeding the
budget fails the unit with a distinct message; a test drives the trip.

### 3.9 Operational hardening (check 9)

- Clone retry (§5 Q1): recommended — bounded attempts (3) with transient-style backoff for
  nonzero-exit/timeout clones. On the common path a single-attempt clone converts every network
  blip into a unit error.
- Owned sweep (§5 Q2): recommended — `makeRunTempDir` (and the gitcfg dir) writes an owner
  marker (`{pid, startedAtIso}`); the sweep removes marker-less dirs (legacy/compat) and
  dead-pid dirs, retains live-pid dirs. Closes "a second concurrent audit deletes the first's
  live clones" — now a common-path hazard.
- Pacing: git transport per unit is exactly ONE network operation (the clone; `rev-parse`,
  `ls-tree`, `cat-file` are local) — but concurrency knobs reach 64 and fast-FAILING clones
  plus retries could exceed 15 starts/s/repo, so a concurrency argument alone does not
  establish check 9 **by construction**. Instead `github.ts` gets a per-repo clone-transport
  gate: clone starts for the same (host, org, repo) are serialized and spaced ≥ 200 ms apart
  (a Map-keyed gate the retry loop also flows through). At a conservative 2 transport ops per
  clone start that is ≤ 10 ops/s/repo whatever the fan-out or failure rate — a hard
  construction, independent of every knob. Tests: fake clock, two same-repo clones → second
  start ≥ 200 ms later; different repos unaffected. The per-unit event's clone-transport-op
  counter is the accounting the check asks the implementation to show.

## 4. Prototype adoption (benchGrammar.ts / benchFrame.ts) — §5 Q5

The ADR adopted the prototypes; the mechanics are a decision. Options:

- **(a) Move + shim (recommended).** `benchFrame.ts`'s parsers move to `gitFrame.ts` with
  production naming (`GitFrameError`, message prefix `GIT FRAME:`); `benchFrame.ts` becomes a
  re-export shim (`export { GitFrameError as BenchFrameError, … }`) so every bench import keeps
  working and `instanceof` identity is preserved. Bench tests pinning the literal name/prefix
  are updated (test files are outside the freeze digest). `benchGrammar.ts` STAYS the bench's
  lane grammar (its semantics are bench-specific: declared clone shapes, full-oid ls-tree revs,
  pinned rev-parse positionals); `readOnlyGuard` gains the production grammars directly — the
  transplant `benchGrammar`'s own header comment was written for. Honest cost: the shim edit +
  stale header comments move the live frozen-surface digest (fine — disclosed; no gate-relevant
  run happens, and any future run needs a fresh §8 amendment regardless).
- **(b) Import directly.** Production imports `BatchFrameParser` from `benchFrame.ts`. Zero
  drift and zero bench-module edits — though NOT digest stability: the freeze digest covers
  every non-test script, and this implementation moves it regardless by editing `github.ts`
  et al. Costs: production surface permanently named "bench", and the module headers
  ("production untouched until an ADR adopts these") become false anyway.
- **(c) Copy.** Fork-and-drift; rejected unless rvo overrides.

## 5. Decision batch for rvo (one batch, after this plan's codex loop)

1. **Clone retry**: implement bounded retry (3 attempts, backoff) — or accept the
   single-attempt risk with a recorded acceptance in the PR.
2. **Sweep ownership**: implement the pid-marker owned sweep — or record risk acceptance.
3. **Rollout / deletion**: hard cutover in this PR vs a transition arrangement. Under hard
   cutover the precise inventory (verified by non-test caller grep) is: DELETE the
   `tree.truncated` branch, `fetchTreeRecursive`, `cloneShallow` (+ its `git show %cI` call
   and the guard's `show` grammar, which then have zero callers); RELOCATE `walkClone` +
   `cloneReader` into the bench (the T2a/pinning lanes import them; relocation over dead
   production exports); KEEP `parseTreeResponse`/`TreeResponse` (bench T0/T1 REST trees) and
   `BranchHead.treeOid` (bench corpus; orchestrate just stops reading it). The guard's
   checkout clone tuple is retained either way (§3.1 — the bill's letter). Recommendation:
   hard cutover with that inventory.
4. **Constants**: child pool size (recommend: the subprocess semaphore's size — the ratified
   default) and per-read deadline (recommend 60 s, the ratified bench constant; dispose
   deadline 10 s).
5. **Prototype adoption mechanics**: §4 (a) move+shim (recommended) / (b) import / (c) copy.
6. **Fallback-budget denominator**: §3.8 — the enumerable `eligible` upper bound
   (recommended, a disclosed deviation from the bill's literal `selected`) vs a running ratio
   vs end-of-unit enforcement.

## 6. Phases (TDD; commit before reviewers; santa loop per phase batch)

- **P1 — grammars.** readOnlyGuard tables first (RED) → grammar code (GREEN). Pure.
- **P2 — gitFrame port + writer.** Port tests (adapted from `benchFrame.test.ts`) + new
  writer-rejection and blob-oid tests first → port + helpers. Includes the §4 shim if chosen.
- **P3 — spawn seam + child + pools.** The parameterized launch primitive, `gitBytes`,
  `launchBatchChild`, the child manager in `contentStore.ts`, both pools. Injected-child test
  seam (scripted stdout/stdin fakes) designed here — the one-shot seam is not stretched;
  interactive children get their own injectable launch type. Deadlock + fan-out + lifecycle
  tests first.
- **P4 — rewiring.** `cloneNoCheckout` (+ coherence), store open, `processUnit` swap, abort
  threading, counters/budget event, retirement deletions per Q3. Fixture-driven end-to-end unit
  tests (check 5's byte fixtures live here or in P3).
- **P5 — hardening.** Retry + owned sweep per Q1/Q2 (or recorded acceptances in the PR
  body) + the per-repo clone-transport pacing gate (§3.9 — not optional; check 9).
- Throughout: 2412 pre-existing tests green, `tsc --noEmit` clean, new-module coverage ≥ 80%,
  no comment/test spells a scan-tripping token (AST assertions instead of process/dynamic-load
  tricks), signed commits, lease pushes.

## 7. Disclosed behavior changes (PR body material)

1. Non-UTF-8 blobs: delivered strings become the canonical UTF-8-with-replacement decode
   (REST's transcode measured and disqualified at Step C) — the ratified direction.
2. Moved branch between discovery and clone: a NEW failure mode on every unit. Today's
   default path reads at the pinned discovery OIDs, so a branch move cannot affect it at all
   (only the truncated-clone fallback raced, and it ACCEPTED the moved head, recording the
   clone's real HEAD). Under T2c every unit clones by branch name and fails closed on a HEAD ≠
   pinned-OID mismatch (ratified §3.1(2)) — fast-moving branches will occasionally error a
   unit; transient, self-heals via next-run re-discovery.
3. The 100k-entry/7 MB truncation cliff and its checkout fallback are gone; huge repos now
   enumerate completely — and their symlinks are now visible (walkClone skipped symlinks
   entirely), so symlink findings can APPEAR on repos previously scanned via the fallback.
4. Symlink reads spend REST budget under a per-unit cap (new, ratified failure mode:
   budget-exhausted units fail with a distinct error).
5. Every unit touches disk (pack-only store; measured envelope 293.3 MiB max sampled peak).
6. api_cache: per-unit tree rows stop being written; content rows only for symlink fallbacks.
7. `--fresh`/resume semantics, config hash, report/export schemas: unchanged.

## 8. Doc sweep (I4, after the final santa loop)

README §security (spawn-site prose stays true — verify counts/wording), README log-vocabulary
table, PROMPT.md content-path description, EXPORTS.md entries for `gitFrame.ts`/
`contentStore.ts` + retired exports (exportsDoc.test.ts re-pinned), the ADR's
"until then production keeps today's routing" clause updated to record the landing (PR-linked,
past tense — a form true after the merge), bench module headers if §4(a).

## 9. Review-process ledger (filled as the loops run)

- Plan codex loop: **round 1** (gpt-5.5 @ xhigh, 2026-08-03): CONSULT-FAIL — 1 P1
  (the fallback-budget `selected` cannot be computed up-front in production; the bench
  recorded it by running selection — became §5 Q6 with the `eligible` upper-bound
  recommendation), 3 P2 (pacing needed a real by-construction gate → the per-repo 200 ms
  clone gate; single-shape guard option reinterpreted the bill → both clone tuples retained;
  moved-branch disclosure missed that the default path has no race today → §7.2 rewritten),
  1 P3 (option (b)'s "digest unmoved" claim false → corrected). All five applied. Round 2:
  (pending)
- Per-phase santa loops: (pending)
- Final whole-diff santa loop (cap 5): (pending)
- Doc-sweep codex prose pass: (pending)
