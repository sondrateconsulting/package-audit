# Plan: resolve ADR-0001's two recorded disagreements

- **Status:** draft, under adversarial review (Codex gpt-5.6-sol)
- **Date:** 2026-07-28
- **Owner:** rvo
- **Subject:** [ADR-0001](../adrs/0001-file-content-acquisition-strategy.md), shipped as PR #27, status `proposed`

ADR-0001's Review history records two disagreements with its adversarial reviewer as unresolved.
This plan resolves both — not by re-arguing them, but by converting each into committed, executable
work whose outcome both positions accept in advance.

## 1. The disagreements, and what is actually unresolved

**D1 — the option-selecting benchmark.** The reviewer would have the benchmark run *before*
acceptance. The ADR already concedes the structure — it stays `proposed` behind a pre-acceptance
gate — but the gate as written is four lines of requirements: no harness, no named corpus, no
workload definition, and a *promised* "predeclared margin" that is never actually declared. A gate
that cannot be executed is a gate in name only, so the disagreement stays live. It also names
Option 3 as a benchmark competitor although the ADR itself concludes Option 3 "composes with any
transport rather than competing" — a category error that would make the comparison unfair (a cold
run over unique OIDs shows an OID cache doing nothing).

**Residual gap:** the benchmark must become a concrete, runnable artifact with a pre-registered
decision rule, so that the distance between "recommend now, gate acceptance" and "measure first"
becomes operational rather than philosophical.

**D2 — the canonical-object clone variant.** The reviewer holds that a clone variant reading
*canonical objects* deserves its own evaluation; the ADR lists it under Follow-on work. The
substance of the reviewer's position: the argument that decided against the clone options —
`.gitattributes` checkout transformations destroying byte determinism — does not apply to a clone
that never checks out, and the ADR's own text concedes the `readOnlyGuard` exclusion of `cat-file`
is "a real *cost* … not impossibility". Deferring the strongest challenger to follow-on work while
accepting the incumbent would decide the question by scheduling.

**Residual gap:** the variant must be specified and evaluated *inside ADR-0001's decision*, on the
same footing as the other options, and it must be a row in the option-selecting benchmark.

## 2. Resolution shape

1. **D1 resolves** by replacing the Confirmation gate's sketch with the benchmark specification in
   §4: pinned corpus, pinned per-repo workloads, four transport drivers, a fixed protocol, and a
   pre-registered eligibility-and-selection rule. The ADR's acceptance flow becomes: harness lands
   → run happens → committed report → status flips (or the outcome is rewritten and re-reviewed).
   Deliverables and closure points in §6.
2. **D2 resolves** by defining **Option 2c** (§3), adding it to ADR-0001's Considered Options with
   a full pros/cons section, reworking the Decision Outcome so the case for Option 1 no longer
   leans on a byte-fidelity argument that 2c defeats, and adding 2c as benchmark driver T2c. The
   selection rule (§4.7) is symmetric — no incumbency margin — so the evaluation is on equal
   footing by construction.

Both resolutions preserve the ADR's honest posture: the recommendation stays provisional, and the
recorded disagreements stay in the Review history — annotated with how each was closed, not erased.

## 3. Option 2c — per-unit clone, no checkout, canonical-object reads

### 3.1 Definition

For each branch unit on the default path (production shape; the benchmark's acquisition variant is
§4.4):

1. `git clone --depth 1 --single-branch --branch <b> --no-tags --no-recurse-submodules
   --template= --no-checkout <url> <dir>` — the production argv
   ([github.ts:2024](../../scripts/github.ts#L2024)) plus `--no-checkout`. No working tree is ever
   materialised, so `.gitattributes` (`eol`, `ident`, `working-tree-encoding`) never runs.
2. Head coherence: `git rev-parse HEAD` (already allowlisted,
   [readOnlyGuard.ts:236](../../scripts/readOnlyGuard.ts#L236)) must equal the discovery-pinned
   OID, else fail closed — the same force-push guard Option 2a needs.
3. Enumeration: `git ls-tree -r -z -l --full-tree HEAD` replaces the per-unit REST tree request
   entirely — mode, type, OID, *canonical object size*, and path for every entry, with no
   100,000-entry / 7 MB truncation cliff.
4. Content: `cat-file --batch`, spawned with `GIT_NO_REPLACE_OBJECTS=1` in the environment (via
   the existing [buildGitEnv](../../scripts/github.ts#L301) seam — an env var, deliberately, because
   the guard treats a pre-verb global like `--no-replace-objects` as the verb and denies it,
   [readOnlyGuard.ts:225](../../scripts/readOnlyGuard.ts#L225)). One bounded child per read round:
   write regex-validated `^[0-9a-f]{40}$` OIDs to stdin, close stdin, read framed output to EOF.
   No long-lived interactive child.

**The batching seam is shared with Option 1, not avoided.** `scanUnit` consumes one path at a time
through `ReadFile` ([unitPipeline.ts:46](../../scripts/unitPipeline.ts#L46)) and discovers
second-round paths only after parsing manifests, so 2c needs exactly the same two-phase
prefetch/consume refactor Option 1 needs — round 1 (manifests + CLI-classifiable paths), round 2
(relevant sources + elected lockfiles), each round dispatching one `cat-file --batch` child instead
of one GraphQL batch. The seam refactor is therefore **common cost to both finalists and neutral in
the comparison**; neither option's ledger may claim it against the other.

**Symlinks** (mode `120000`), routed by the ls-tree mode exactly as Option 1 routes by validated
tree mode, go to the same REST `fetchFileRaw` fallback to preserve today's dereferenced-bytes
findings. **Binary and non-UTF-8 blobs:** `cat-file` returns raw bytes natively, but the `ReadFile`
seam is a *string* contract and today's pipeline never consumes raw binary (the one binary lockfile
kind, `bun.lockb`, is surfaced as `binary: true` and never content-read —
[manifest.ts:172](../../scripts/manifest.ts#L172),
[unitPipeline.ts:142](../../scripts/unitPipeline.ts#L142)). For findings parity, 2c applies the
same UTF-8 decode at the seam that the REST path applies today — the raw-bytes capability is
**latent** (it removes the *transport's* lossiness, and enables future raw consumers, but does not
change delivered strings). The 2 MiB gate reads ls-tree's object sizes, which are canonical and
platform-independent — fixing 2a's transformed-`lstat`-size problem.

### 3.2 What 2c neutralises, what it inherits, what it adds

**Neutralised (the arguments that decided against 2a):**

- *Byte fidelity*: reads are the committed objects themselves. Self-verifying the same way Option 1
  is — hash the `blob <len>\0<body>` frame against the ls-tree OID, before any seam decode.
- *Symlink hazard*: no filesystem links ever exist; the mode is explicit in ls-tree; policy is a
  routing decision identical in shape to Option 1's.
- *The 2 MiB gate perturbation*: sizes come from object headers, not `lstat` of transformed files.
- *The oversized-and-truncated routing hole*: there is no truncation; ls-tree enumerates any tree.
- *The per-unit REST tree request* — the one term Option 1 leaves standing — is eliminated.

**Inherited from 2a (unchanged):** the disk lease and the unowned startup sweep
([github.ts:2096](../../scripts/github.ts#L2096)); single-attempt clone with no retry
([github.ts:2031](../../scripts/github.ts#L2031)); git transport pacing with no headroom header
(15 read ops/s/repo, recommended not enforced); whole-branch pack transfer regardless of how few
files are selected; per-unit subprocess fan-out. Disk footprint is *smaller* than 2a (pack only,
no working tree), but nonzero on every unit — the common path now touches disk, where Option 1's
common path does not.

**New surface (2c's own ledger, the honest price):**

- Guard grammar work in three parts, none of it "add a flag to a set":
  (i) a **second exact clone shape** — the guard's clone grammar makes every allowlisted option
  *mandatory, exactly once* ([readOnlyGuard.ts:287](../../scripts/readOnlyGuard.ts#L287)), so
  `--no-checkout` cannot join the shared boolean set without breaking 2a's shape; the grammar
  gains a second required-tuple variant instead; (ii) a fixed `ls-tree -r -z -l --full-tree HEAD`
  tuple; (iii) a fixed `cat-file --batch` tuple with `--textconv`/`--filters` structurally absent
  (the guard's comment currently excludes `cat-file` by name,
  [readOnlyGuard.ts:206](../../scripts/readOnlyGuard.ts#L206); ADR-0001 already concedes this is a
  cost, not an impossibility).
- A stdin protocol the guard cannot see: `assertReadOnlyGit` validates argv, but `--batch` resolves
  arbitrary revs from stdin. Containment moves to the caller: a writer that emits only
  regex-validated 40-hex OIDs, tested exhaustively. A genuinely new trust boundary — 2c's weakest
  point.
- A binary framed-spawn seam serving both new verbs: the production spawn is `stdin: "ignore"` and
  irreversibly UTF-8-decodes stdout under a single aggregate byte cap
  ([github.ts:168](../../scripts/github.ts#L168),
  [github.ts:180](../../scripts/github.ts#L180)). The new seam must pipe stdin, parse
  `--batch` framing — `<oid> SP <type> SP <size> LF`, `<size>` raw body bytes, LF trailer, plus
  `<oid> missing LF` records — validating OID echo, type, size, ordering, and exact request/response
  correspondence (no missing or extra frames), bounding header length and aggregate output,
  draining stderr, and preserving the existing kill-escalation and deadline behaviour. `ls-tree -z`
  output needs the same raw-byte handling: a path that is not valid UTF-8 must fail closed at the
  seam, not silently mojibake into a mismatched key.

### 3.3 Evaluation stance

2c is the strongest challenger to Option 1, and the two are near-mirror images. Shared cost: the
two-phase batching seam. Option 1's distinct costs: the API-wide admission scheduler, admission
caps, partial-response handling, cache provenance. 2c's distinct costs: guard grammar work, the
stdin trust boundary, the framed binary seam, disk on every unit, clone retry/pacing policy.
Option 1's distinct asymmetry: its surface is in-process and exercisable by the existing
injected-spawn tests; 2c's includes a subprocess protocol boundary. Neither ledger can be settled
by argument — which is precisely why D1's benchmark exists, and why §4.7's rule is symmetric:
performance is measured, the ledger is judged by the decision-maker, and no numeric handicap
converts one into the other.

## 4. The option-selecting benchmark, specified

### 4.1 Harness

`scripts/benchContentTransport.ts` (flat, matching repo convention), run as
`bun run bench:content`. Standalone: it reuses production modules where realism demands
(selection logic, throttle classification, GraphQL query construction) but never touches the
production database or temp prefix. Not in CI — it needs live network and burns real budget; its
pure planning functions (batch packing, corpus validation, frame parser) get ordinary unit tests
that do run in CI. Results land in `docs/adrs/0001-benchmark/` as committed artifacts:
`corpus.json`, `bench-config.json`, per-repo `selected/*.json`, `runs.jsonl`, `report.md`.

**Guard discipline applies to transport, not instrumentation.** Every *transport* operation a
driver performs must use exactly the argv/env its option's production design specifies; for 2c that
means the proposed grammars, which ship in the harness PR as a standalone module the bench asserts
every transport spawn against (production `readOnlyGuard` is untouched until an ADR adopts them).
Measurement instrumentation — `du` over a temp dir, reading `rate_limit` — is bench-local and
outside that discipline.

### 4.2 Corpus

Six slots. Candidates are named now; final pinning (owner/repo, branch, 40-hex SHA — per branch
for C1) happens in the harness PR, with each slot's qualifying property *verified at pinning time*
and recorded in `corpus.json`. A candidate that fails verification is swapped, not forced.

| Slot | Purpose | Candidate(s) | Pinning verification |
|---|---|---|---|
| C1 | Multi-branch tree sharing + concurrency probe | `fastify/fastify` (main + ≥2 released lines, each a pinned named branch unit) | ≥3 branches; ≥80% shared tree OIDs between two of them |
| C2 | Mid-size typical service repo | `nodejs/undici` | 1k–3k files; JS/TS manifests present |
| C3 | Path-heavy tree | `NixOS/nixpkgs` | recursive-tree payload dominated by path bytes; deep nesting |
| C4 | Truncated tree | `llvm/llvm-project`, else `chromium/chromium` | REST recursive tree returns `truncated: true` at the pinned SHA |
| C5 | Checkout-transforming `.gitattributes` | `PowerShell/PowerShell`, else a `dotnet/*` repo | ≥1 selected file whose checkout bytes ≠ blob bytes under `core.autocrlf=true` |
| C6 | Fidelity fixtures: symlink + non-UTF-8 | `nodejs/node` @ `b2a024b1…` (M9, API-only), plus a small clone-feasible repo with a mode-`120000` entry among selected paths (candidate: `git/git`) and ≥1 selected file whose bytes are not valid UTF-8 | tree lists a mode-`120000` selected entry; the non-UTF-8 entry decodes with replacement characters |

C1–C5 form the **performance corpus** (repeated timed runs). C6 is a **fidelity battery**: every
driver must resolve its entries with declared-route-correct bytes, but it is not repeatedly timed —
`nodejs/node` is too heavy to cold-clone K times for no additional information.

**Workloads are never truncated.** The earlier idea of capping selected sets at a fixed prefix is
withdrawn: a prefix cap structurally favours API drivers (it caps their per-file requests while
clone drivers still transfer the whole branch) and can break the manifest→source/lockfile
dependency shape. Instead, *corpus selection* prefers repos whose natural selected-set size is
≤ ~500 files for C1/C2/C5; C3/C4 keep their natural (large) sets and the budget math in §4.8
absorbs it. Whatever the production selection selects, every driver resolves in full.

**C4 runs the production designs, not idealisations.** On a truncated tree, T0 and T1 both fetch
the REST tree, observe `truncated: true`, and take the existing checkout-clone fallback
([orchestrate.ts:823](../../scripts/orchestrate.ts#L823)) — exactly as production routes today and
as Option 1 retains. T2a clones with checkout by definition; T2c takes its `--no-checkout` +
`ls-tree` path. The discriminating comparison on C4 is therefore {REST tree attempt + checkout
clone + walk} vs {no-checkout clone + ls-tree + cat-file}, and every driver resolves the same
workload, so the scenario aggregates comparably.

### 4.3 Workload pinning and ground truth

At pinning time, once per corpus unit (repo × branch):

1. **Pin the bench configuration** as a committed artifact (`bench-config.json`): the
   tracked-package set, exclusion globs, CLI-classifier terms, size-gate constants — everything
   selection depends on. The workload is a function of (config, repo, SHA) and all three are
   pinned.
2. Run the production selection logic (manifest location → lockfile election → source/CLI gates)
   against the pinned SHA via the status-quo path, recording the final selected set: `{path, mode,
   blobOid, size, class}` per entry, committed under `selected/`.
3. Record ground truth per entry as a **route-expectation matrix**: for each driver, the declared
   route (primary | symlink-fallback | binary-lockfile-skip | truncated-fallback) and the expected
   *seam-level string* (sha256 of the UTF-8-decoded bytes that route delivers — REST-dereferenced
   bytes for symlink fallbacks, decoded blob bytes elsewhere), plus the canonical blob-bytes sha256
   for raw-capable verification (T1 hash-validated text; T2c pre-decode frames). Symlink REST
   expectations are deterministic because the dereference target is pinned by the same commit.
   Pinning tooling is unconstrained (full local clone; not a measured activity).

### 4.4 Drivers

| Driver | Option | Shape |
|---|---|---|
| T0 | Status quo | REST `contents` per file, production Accept header, production concurrency semantics, production throttle classification |
| T1 | Option 1 | Aliased GraphQL blob batches under **fixed pre-declared caps**; two-round dispatch exactly as the production design forces; per-alias hash validation; symlink/binary/truncated → REST fallback, counted |
| T2a | Option 2a | Option 2a *as considered in the ADR*: shallow clone + checkout, local enumeration, mode-routed symlink policy (REST fallback), head-coherence check |
| T2c | Option 2c | §3.1 exactly: `--no-checkout` clone, `rev-parse` coherence, `ls-tree -r -z -l`, per-round `cat-file --batch` with framed binary reads, seam-level UTF-8 decode |

**Drivers implement the considered designs, minimally.** Each driver is the minimal faithful
implementation of its option as evaluated in the ADR — including the parts today's code lacks
(T2a's symlink routing and coherence check; T1's validation and fallback routing). Benchmarking
today's accidental gaps (e.g. `walkClone` skipping symlinks silently) would fail drivers on
implementation trivia rather than evaluate the options.

**T1 caps are fixed before the matrix, not tuned by it.** Declared in `bench-config.json` from the
ADR's M-series evidence, conservatively: alias cap 250 (M2's measured point, ~1.9 s client headroom),
query-document cap 48 KiB, per-batch content estimate cap 2.5 MiB (from tree sizes), argv cap
128 KiB. The matrix runs entirely under these constants. A separate **informational boundary
probe** (not part of scoring, runs after the matrix) sweeps alias counts {250, 300, 350, 400, 425,
450, 475} × 3 tries against one mid-size repo to map the failure boundary and test whether M4's
462-alias 502 is deterministic — evidence for the production caps ADR-0001 requires, without giving
the benchmark a self-tuning lever.

**Clone acquisition is SHA-pinned; production argv is validated separately.** `git clone --branch`
takes a ref name, not a SHA, so a branch that advances after pinning would make T2a silently scan a
different commit and T2c fail its own coherence gate — the workload would drift under the
benchmark. Timed runs therefore acquire by pinned SHA: `git init` + `git remote add origin <url>` +
`git fetch --depth 1 origin <sha>` (+ `git checkout --detach FETCH_HEAD` for T2a only) — the
actions/checkout pattern; GitHub serves reachable advertised heads by SHA. Transport equivalence
(same object set as a branch clone at that head) is validated at pinning time: while the live head
still equals the pinned SHA, run the production `cloneShallow` argv once per clone driver, assert
equal pack object counts and record both wall times in `report.md`. If a pinned SHA later becomes
unreachable (force-push), the fetch fails loudly and the slot is re-pinned — never silently
re-resolved.

**Option 3 is not a driver.** It is evaluated the way the ADR already recommends: an offline
duplicate-OID analysis over the corpus trees (cheap, no network), reported alongside — plus one
warm-run scenario (advance C1 one commit, re-run the winning driver with and without OID keying)
to quantify what Option 3 would add *compositionally*.

### 4.5 Protocol

- **K = 5** repetitions per (performance-corpus unit × driver). A *run* is: fresh temp dir, empty
  cache DB, resolve every workload entry, tear down. The bench temp prefix is **`pa-bench-*`** —
  deliberately *not* prefixed `pkg-audit-`, because the production startup sweep deletes every
  `pkg-audit-*` entry unconditionally ([github.ts:2096](../../scripts/github.ts#L2096)) and would
  reap live benchmark directories.
- **Ordering:** driver order rotates per repetition by a fixed cyclic schedule (rep *i* starts at
  driver *i* mod 4), so no driver systematically runs first or immediately after another's clone of
  the same repo — decorrelating network drift and any server-side pack-cache warmth from driver
  identity.
- **Cold** means: no `api_cache` rows, no reused clones, no HTTP cache. DNS/TLS warmth is ambient
  and shared.
- **Completion discipline:** eligibility requires all K runs complete. One rerun per (unit, driver)
  is permitted for an externally-caused failure (network flake, 5xx storm), with the original
  failure kept in `runs.jsonl` and the cause recorded; a second failure marks the driver ineligible
  on that unit (G3).
- **T2a determinism probe:** T2a runs K reps under `core.autocrlf=false` plus one additional rep
  under `core.autocrlf=true`; any byte divergence between the two on the same entry is a G1
  determinism failure with the diff attributed to C5's `.gitattributes`.
- **Concurrency probe (informational, API drivers).** The serial matrix cannot observe the shared
  REST/GraphQL secondary limits that concern Option 1's scheduler. After the matrix: run C1's
  branch units as 4 concurrent streams for T0 and for T1, recording every secondary-limit signal.
  Results are reported, not scored — they evidence the scheduler requirement, they do not rank
  drivers.
- Each run records `rate_limit` headroom before/after (both `core` and `graphql` buckets) and every
  secondary-limit signal, classified as production does
  ([github.ts:541](../../scripts/github.ts#L541)): header-signalled 429/`retry-after`,
  body-signalled 403 secondary-limit responses, and GraphQL `RATE_LIMITED` error codes.

### 4.6 Metrics, per run

1. Wall time (workload start → last entry resolved).
2. HTTP requests by class: REST content, REST tree, REST fallback, GraphQL requests; GraphQL
   points as the *measured* `rateLimit { cost }` sum, never the formula.
3. Transfer, reported as two explicitly non-comparable kinds: HTTP body bytes (API drivers) and
   on-disk object-store bytes after acquisition (`du` over `.git/objects`, clone drivers — labelled
   on-disk, since git reports no clean transfer-byte figure without packet tracing).
4. Peak disk under the run's temp dir.
5. Failures: 5xx, timeouts, retries (attempt-counted), fallback count by cause (symlink, binary,
   truncated, batch-error), incomplete entries, secondary-limit signals by kind.
6. Fidelity: every delivered entry checked against the §4.3 route-expectation matrix at the string
   seam; raw-capable drivers additionally verify pre-decode bytes against the canonical blob hash.

Aggregation per (unit, driver): **p50 and worst-of-K** — with K = 5 there is no meaningful p95, and
the worst observation is reported as what it is. The derived headline, computed per unit:

> **Budget-normalised serial throughput** — selected files resolvable per hour by one serial
> worker, `min(bucket ceiling, wall throughput)`: bucket ceiling = `5000 × files ÷ units-consumed`
> per applicable bucket (REST requests against `core`; GraphQL points against `graphql`; the
> binding bucket governs), wall throughput = `3600 × files ÷ p50 seconds`. Tree acquisition counts
> toward units (T0/T1 pay it; T2a/T2c do not); discovery (repo/branch listing) is excluded as
> identical across drivers. Reported per bucket size so 15,000-point credentials read off the same
> data.
>
> **Scope, stated plainly:** this is a per-scenario serial cost profile, *not* an estate
> simulation. It does not exercise concurrent fan-out, the shared REST+GraphQL CPU budget under
> contention, cross-unit cache effects, or aggregate clone disk across parallel units. Those
> remain design-ledger items (§4.7); the concurrency probe (§4.5) evidences them without scoring
> them.

### 4.7 Pre-registered rule: eligibility, comparison, and who decides

**Eligibility gates, per driver (all must hold):**

- **G1 Determinism/fidelity:** delivered strings match the route-expectation matrix for every
  entry in all reps; raw-capable verification passes where declared; invariant across the T2a
  gitconfig probe. A driver whose policy cannot state expected bytes machine-independently fails
  G1 by construction; the measured divergence is the evidence.
- **G2 Completeness:** every workload entry resolves via its declared route; a whole-batch failure
  surfacing as silent per-entry absence is a G2 failure, not a fallback.
- **G3 Stability:** all K reps complete, with at most one recorded external-cause rerun per
  (unit, driver); retry storms capped by the production attempt limit.
- **G4 Envelope:** peak disk ≤ 2 GiB per unit (ratifiable constant); every secondary-limit signal
  of any kind (header 429/`retry-after`, body-signalled 403, GraphQL `RATE_LIMITED`) is recorded
  and triggers review of the offending driver's admission behaviour — observed signals are
  findings, never silently tolerated.

**Comparison (symmetric — no incumbency margin):** per performance-corpus unit, compare eligible
drivers' throughput; differences within a **1.25× noise band** are a tie for that unit (five
network-bound reps cannot resolve finer). This yields a per-unit win/tie/loss table. A driver
**dominates** when, against every other eligible driver, it has at least one unit-win and no
unit-losses.

The earlier draft's 2.0× incumbent-displacement margin is withdrawn: both finalists are equally
unimplemented, so there is no incumbent in any engineering sense, and an uncalibrated asymmetric
constant is exactly the thumb on the scale D2's resolution must not contain. Design-surface
differences are not priced into the rule; they are the decision-maker's judgment, exercised on the
ledger (§3.3) alongside the measurements.

**Who decides:** the rule produces the benchmark's *recommendation* — the dominating driver if one
exists, else "no dominator" with the full table. The ADR decision is made by the decision-maker
(rvo): ratifying the recommendation, or overriding it with written rationale recorded in the ADR's
Review history. Ambiguity is escalated as ambiguity; the rule refuses to launder unclear results
into a verdict.

**Outcome mapping:** Option 1 dominates or is ratified → ADR status `proposed → accepted`,
benchmark report linked as decision evidence. A challenger dominates and is ratified → the ADR's
Decision Outcome is rewritten for the winner while still `proposed`, the rewritten ADR goes through
one further adversarial review round, and only then flips to `accepted`. No dominator → the
decision-maker decides on the table + ledger, with rationale recorded; the ADR does not flip until
that rationale is written.

### 4.8 Budget and safety

- API spend estimate is corpus-dependent once C3/C4's natural selected sets are known at pinning;
  the harness computes and prints it before running. The harness is **bucket-aware and
  resumable**: before each run it reads `rate_limit` and proceeds only if
  `projected-spend × 1.5 ≤ headroom` for every bucket the run touches — otherwise it sleeps to the
  reset epoch. Sleeps happen *between* runs, never inside one, so a matrix may span hours without
  polluting per-run measurements; partial results persist and resume.
- Git pacing: well under 15 ops/s/repo by construction (≤ a handful of transport subprocesses per
  run); asserted in the report.
- The bench runs against github.com with an ordinary PAT on public repos only, so every artifact is
  reproducible by anyone.

## 5. ADR-0001 edits (applied in this PR once this plan converges)

1. **Considered Options:** add Option 2c.
2. **New pros/cons section** for Option 2c carrying §3's ledger — neutralised objections, the
   shared batching seam, inherited costs, new surface — with code links.
3. **Decision Outcome:** rework the paragraph that stacks the `cat-file` cost onto "the disk,
   sweep, symlink, and routing problems" to decide against "the clone options" collectively — 2c
   dissolves the symlink and routing members of that list and pays the `cat-file` cost to dissolve
   the byte-fidelity one, so the argument must be re-scoped to 2a, and the case for Option 1 over
   2c restated as §3.3's ledger asymmetry, explicitly benchmark-gated and decided under §4.7's
   symmetric rule. Name 2c the strongest challenger.
4. **Confirmation:** replace the four-line gate sketch with a summary of §4 and a link to this
   plan: corpus slots, drivers (2c included; Option 3 restructured to the compositional analysis),
   eligibility gates, the symmetric 1.25× noise-band comparison, and the outcome mapping including
   the challenger-win re-review. The "predeclared margin" promise becomes an actual predeclared
   rule.
5. **Review history:** annotate the two disagreements with their resolution state, without erasing
   the original record: **D2 is closed by this PR** (the variant is now evaluated in-ADR as Option
   2c and benchmarked as T2c on a symmetric rule); **D1's resolution is committed by this PR and
   discharged at Step D** (spec now exists and is binding; the benchmark itself has not yet run,
   so the ADR remains `proposed` — which is the reviewer's position honoured).
6. **Follow-on work:** the canonical-object clone variant entry is superseded (now in-ADR); the
   tree-request-term entry gains "Option 2c eliminates this term; if Option 1 wins, the term
   survives and keeps its own ADR"; Option 3's entry gains the concrete measurement vehicle
   (§4.4's offline analysis + warm scenario).

## 6. Sequencing

| Step | Vehicle | Content | Closure state after step |
|---|---|---|---|
| A | PR #27 (this branch) | This plan + the §5 ADR edits. ADR stays `proposed`. | D2 closed; D1 committed, open until D |
| B | Follow-up PR | Harness, proposed-grammar module, corpus pinning + verification, `bench-config.json`, workload/ground-truth artifacts, planner unit tests. | D1 executable |
| C | Follow-up PR | The run: `runs.jsonl`, `report.md`, boundary probe, concurrency probe, Option-3 analysis, rule output. | D1 evidence complete |
| D | Follow-up PR | Decision per §4.7's outcome mapping: status flip, or rewrite + one further adversarial review round, or recorded-rationale decision. | D1 discharged |

Steps B–D have no calendar deadline — the gate is evidentiary, not temporal.

## 7. Non-goals

- No production implementation of any option (no seam refactor, no scheduler, no guard changes to
  `readOnlyGuard.ts` — the proposed grammars live beside the bench until an ADR adopts them).
- No CI job that talks to the network.
- No re-litigation of settled ADR content (the M-series measurements, the limits table, the
  fail-closed rules) beyond the §5 edits.

## 8. Ratification points (decision-maker sign-off, recorded in the harness PR)

1. The 1.25× noise band (§4.7) and the dominance definition.
2. K = 5, the 2 GiB per-unit disk gate, and the fixed T1 caps in `bench-config.json`.
3. Final corpus pinning after slot verification, including accepting C3/C4's natural workload
   sizes and their budget cost.
4. The symlink policy all drivers declare (REST-deref parity with today) — a findings-visible
   choice.
