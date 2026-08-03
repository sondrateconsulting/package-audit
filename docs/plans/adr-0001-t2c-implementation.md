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
| `github.ts` | (a) the single `Bun.spawn` site gains a stdin-mode parameter and a structural `LaunchedChild` return used by two consumers: the existing one-shot UTF-8 path (unchanged behavior) and the new byte/interactive paths; (b) `gitBytes(args, cwd)` — one-shot guarded byte-capture spawn (for `ls-tree`; the current string path's irreversible decode would destroy the evidence the parser fails closed on); (c) `launchBatchChild(cwd)` — guarded (`assertSpawnAllowed` + `assertReadOnlyGit(["cat-file","--batch"])` + cwd containment), env-built, NOT semaphore-held (children draw from the child pool); (d) `cloneNoCheckout(org, repo, branch, pinnedOid)` — production argv + `--no-checkout`, bounded retry (§5 Q1), `rev-parse HEAD` must equal `pinnedOid` else fail closed; (e) `buildGitEnv` sets `GIT_NO_REPLACE_OBJECTS=1` unconditionally — for **every** git spawn, not just the child: `rev-parse`/`ls-tree` running with replace refs while `cat-file` runs without them would let the coherence check and the enumeration disagree with the reads; (f) the child permit pool (a second `Semaphore`; size §5 Q4); (g) the owned temp sweep (§5 Q2). |
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

- **Clone**: the grammar becomes the union of (at most) two exact tuples — the existing
  checkout tuple and the same tuple + `--no-checkout` required-exactly-once. Union-of-exact
  (rather than a caller-declared shape parameter, which the bench needed to stop driver drift)
  because production's argv is constructed inside `github.ts` from an explicit parameter, so
  cross-shape drift is structurally impossible at the only call site. If rvo picks full
  deletion of the checkout path (§5 Q3), the checkout tuple is REMOVED and the grammar is the
  single no-checkout tuple — the accept/reject table then proves the bare-checkout argv is
  rejected.
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
per unit (vocab-pinned) and aggregated nowhere else (report schema untouched). The per-unit
fallback budget is `max(20, ceil(0.10 × selected))` where `selected` is computed up-front from
the enumerated entries by the SAME pure selection predicates the pipeline uses
(`locateManifests` + non-binary nearest-lockfile kinds + `SCANNABLE_EXT`/`classifyFile` +
`excludeDirGlobs`/`node_modules` + the 2 MiB gate) — the bench pinned `selected` the same way
(bench-config reuses the production classifiers). Exceeding the budget fails the unit with a
distinct message; a test drives the trip.

### 3.9 Operational hardening (check 9)

- Clone retry (§5 Q1): recommended — bounded attempts (3) with transient-style backoff for
  nonzero-exit/timeout clones. On the common path a single-attempt clone converts every network
  blip into a unit error.
- Owned sweep (§5 Q2): recommended — `makeRunTempDir` (and the gitcfg dir) writes an owner
  marker (`{pid, startedAtIso}`); the sweep removes marker-less dirs (legacy/compat) and
  dead-pid dirs, retains live-pid dirs. Closes "a second concurrent audit deletes the first's
  live clones" — now a common-path hazard.
- Pacing: git transport per unit is exactly ONE network operation (the clone; `rev-parse`,
  `ls-tree`, `cat-file` are local). Concurrent clones are bounded by the global subprocess
  semaphore (default 8) across ALL repos, and per-repo unit fan-out ≤ `concurrency.branches`;
  a repo's clone rate is therefore ≤ min(semaphore, branches) starts per clone-duration —
  far under 15 ops/s/repo for any real clone (≥ ~0.5 s). The accounting shows it: the per-unit
  event counts clone-transport ops, so any future reviewer can recompute the bound. No
  enforcement machinery (no headroom header exists); the construction argument + counters are
  the check-9 "shows its accounting".

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
  drift, zero bench edits, digest unmoved — but production surface permanently named "bench",
  EXPORTS.md documents a bench module as a production dependency, and the module headers
  ("production untouched until an ADR adopts these") become false anyway.
- **(c) Copy.** Fork-and-drift; rejected unless rvo overrides.

## 5. Decision batch for rvo (one batch, after this plan's codex loop)

1. **Clone retry**: implement bounded retry (3 attempts, backoff) — or accept the
   single-attempt risk with a recorded acceptance in the PR.
2. **Sweep ownership**: implement the pid-marker owned sweep — or record risk acceptance.
3. **Rollout / deletion**: hard cutover deleting the retired path in this PR (`walkClone`,
   `cloneReader`, the truncated-tree branch, `cloneShallow` + the checkout clone tuple + the
   `git show` date tuple, which then have no callers) — vs keeping any of it behind
   dead-code/transition cover. Recommendation: full deletion (the ADR retired the path; the
   guard shrinks to the narrowest live grammar).
4. **Constants**: child pool size (recommend: the subprocess semaphore's size — the ratified
   default) and per-read deadline (recommend 60 s, the ratified bench constant; dispose
   deadline 10 s).
5. **Prototype adoption mechanics**: §4 (a) move+shim (recommended) / (b) import / (c) copy.

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
- **P5 — hardening.** Retry + owned sweep per Q1/Q2 (or recorded acceptances in the PR body).
- Throughout: 2412 pre-existing tests green, `tsc --noEmit` clean, new-module coverage ≥ 80%,
  no comment/test spells a scan-tripping token (AST assertions instead of process/dynamic-load
  tricks), signed commits, lease pushes.

## 7. Disclosed behavior changes (PR body material)

1. Non-UTF-8 blobs: delivered strings become the canonical UTF-8-with-replacement decode
   (REST's transcode measured and disqualified at Step C) — the ratified direction.
2. Moved branch between discovery and clone: unit fails closed (was: scanned at the moved head
   on the truncated-clone path only). Self-heals next run.
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

- Plan codex loop: (pending)
- Per-phase santa loops: (pending)
- Final whole-diff santa loop (cap 5): (pending)
- Doc-sweep codex prose pass: (pending)
