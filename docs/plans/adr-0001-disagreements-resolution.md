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
   → run happens → committed report → a Step-D decision that itself passes one adversarial review
   round, whatever its direction. Deliverables and closure points in §6.
2. **D2 resolves** by defining **Option 2c** (§3), adding it to ADR-0001's Considered Options with
   a full pros/cons section, reworking the Decision Outcome so the case for Option 1 no longer
   leans on a byte-fidelity argument that 2c defeats, and adding 2c as benchmark driver T2c. The
   selection rule (§4.7) is symmetric — no incumbency margin, and identical review requirements on
   every outcome — so the evaluation is on equal footing by construction.

Both resolutions preserve the ADR's honest posture: the recommendation stays provisional, and the
recorded disagreements stay in the Review history — annotated with how each was closed, not erased.

## 3. Option 2c — per-unit clone, no checkout, canonical-object reads

### 3.1 Definition (production shape)

For each branch unit on the default path (the benchmark's SHA-pinned acquisition variant is §4.4):

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
   the existing [buildGitEnv](../../scripts/github.ts#L301) seam — an env var, deliberately,
   because the guard treats a pre-verb global like `--no-replace-objects` as the verb and denies
   it, [readOnlyGuard.ts:225](../../scripts/readOnlyGuard.ts#L225)). One bounded child per read
   round, fed only OIDs that pass the request-side filter (entries the round actually needs, size
   ≤ the 2 MiB gate per ls-tree). The child lifecycle **pumps concurrently with backpressure** —
   stdin writes interleave with framed stdout reads and stderr draining, stdin closes after the
   last OID, frames are consumed as streams (hash/deliver incrementally, never buffer the
   aggregate) — because writing all OIDs before reading deadlocks once either pipe buffer fills.
   Kill-escalation and the subprocess deadline are preserved.

**Object-format awareness.** OID validation, ls-tree parsing, and frame verification are keyed to
the repository's object format: 40-hex SHA-1 or 64-hex SHA-256, matching the dual format
`github.ts` already accepts for API OIDs — a hardcoded `^[0-9a-f]{40}$` would regress SHA-256
repositories. Blob self-verification hashes `blob <len>\0<body>` with the matching algorithm.
Mixed-format listings are rejected.

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
  is — hash the frame against the ls-tree OID, before any seam decode.
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
  gains a second required-tuple variant instead; (ii) a fixed `ls-tree -r -z -l --full-tree <rev>`
  tuple; (iii) a fixed `cat-file --batch` tuple with `--textconv`/`--filters` structurally absent
  (the guard's comment currently excludes `cat-file` by name,
  [readOnlyGuard.ts:206](../../scripts/readOnlyGuard.ts#L206); ADR-0001 already concedes this is a
  cost, not an impossibility).
- A stdin protocol the guard cannot see: `assertReadOnlyGit` validates argv, but `--batch` resolves
  arbitrary revs from stdin. Containment moves to the caller: a writer that emits only
  format-validated OIDs, tested exhaustively. A genuinely new trust boundary — 2c's weakest point.
- A binary framed-spawn seam serving both new verbs: the production spawn is `stdin: "ignore"` and
  irreversibly UTF-8-decodes stdout under a single aggregate byte cap
  ([github.ts:168](../../scripts/github.ts#L168),
  [github.ts:180](../../scripts/github.ts#L180)). The new seam must pipe stdin with concurrent
  backpressure-aware pumping (§3.1), parse `--batch` framing — `<oid> SP <type> SP <size> LF`,
  `<size>` raw body bytes, LF trailer, plus `<oid> missing LF` records — validating OID echo,
  type, size, ordering, and exact request/response correspondence (no missing or extra frames),
  bounding header length and per-frame size (request-side filtered to the 2 MiB gate), streaming
  frame consumption so aggregate memory stays O(one frame), draining stderr, and preserving the
  existing kill-escalation and deadline behaviour.
- An `ls-tree -z` parser with a closed validation set: NUL-delimited records; mode in the closed
  set `100644/100755/120000/040000/160000` with exact mode→type coherence; OIDs in the repository's
  object format; blob sizes as bounded nonnegative integers (`-` only for non-blobs); paths
  non-empty, valid UTF-8 (else fail closed — no mojibake keys), canonical under the same rules as
  `isCanonicalTreePath` ([github.ts:774](../../scripts/github.ts#L774)), and unique across the
  listing (duplicates fatal); malformed or trailing bytes fatal.

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
production database, temp prefix, or production source files — §7's "no seam refactor" applies to
production code; the bench builds its own bench-local seams, including the **framed binary spawn
reader, which is written as a deliverable prototype** of §3.2's seam (its parser is a pure function
with CI unit tests, including synthetic invalid-UTF-8-path and malformed-frame fixtures). Not in
CI as a network job — it needs live network and burns real budget; its pure planning functions
(batch packing, corpus validation, frame parser, schedule table) get ordinary unit tests that do
run in CI. Results land in `docs/adrs/0001-benchmark/` as committed artifacts: `corpus.json`,
`bench-config.json`, per-repo `selected/*.json`, `runs.jsonl`, `report.md`.

**What the proposed-grammar module covers.** The harness PR ships the proposed `readOnlyGuard`
grammars as a standalone module (production guard untouched), and the bench asserts against it for
the **transport operations under evaluation**: both exact clone shapes, the `ls-tree` tuple, the
`cat-file --batch` tuple. The SHA-pinned acquisition scaffolding (§4.4: `init`/`remote
add`/`fetch`/`checkout --detach`) is *bench scaffolding, not proposed production grammar* — its
exact argv tuples are pinned in `bench-config.json` so runs are reproducible, but no production
claim attaches to them. Measurement instrumentation (`du`, `rate_limit` reads) is bench-local and
outside guard discipline entirely.

### 4.2 Corpus

Six slots. Candidates are named now; final pinning (owner/repo, branch, 40-hex SHA — per branch
for C1) happens in the harness PR, with each slot's qualifying property *verified at pinning time*
and recorded in `corpus.json`. A candidate that fails verification is swapped, not forced.

| Slot | Purpose | Candidate(s) | Pinning verification |
|---|---|---|---|
| C1 | Multi-branch tree sharing + concurrency probe | `fastify/fastify` (main + released lines, each a pinned named branch unit) | ≥4 branch units (the probe needs 4 streams); ≥80% shared tree OIDs between two of them |
| C2 | Mid-size typical service repo | `nodejs/undici` | 1k–3k files; JS/TS manifests present; REST tree `truncated: false` |
| C3 | Path-heavy tree | `NixOS/nixpkgs` | recursive-tree payload dominated by path bytes; deep nesting; REST tree `truncated: false` (else it is a C4, not a C3) |
| C4 | Truncated tree | `llvm/llvm-project`, else `chromium/chromium` | REST recursive tree returns `truncated: true` at the pinned SHA |
| C5 | Checkout-transforming `.gitattributes` | `PowerShell/PowerShell`, else a `dotnet/*` repo | ≥1 selected file whose checkout bytes **differ between `core.autocrlf=false` and `core.autocrlf=true`** at the pinned SHA — the divergence the probe measures, not merely checkout-vs-blob |
| C6 | Fidelity fixtures: symlink + non-UTF-8 content | `nodejs/node` @ `b2a024b1…` (M9, API-only), plus a small clone-feasible repo with a mode-`120000` entry among selected paths (candidate: `git/git`) and ≥1 selected file whose bytes are not valid UTF-8 | tree lists a mode-`120000` selected entry; the non-UTF-8 entry decodes with replacement characters |

C1–C5 form the **performance corpus** (repeated timed runs). C6 is a **fidelity battery**: every
driver must resolve its entries with declared-route-correct bytes, but it is not repeatedly timed —
`nodejs/node` is too heavy to cold-clone K times for no additional information. Invalid *path*
bytes (as opposed to content) are covered by the parser's CI unit tests with synthetic fixtures —
committed non-UTF-8 paths in stable public repositories are not reliably available, and the
failure mode is a parser property, not a network property.

**Workloads are never truncated.** The earlier idea of capping selected sets at a fixed prefix is
withdrawn: a prefix cap structurally favours API drivers (it caps their per-file requests while
clone drivers still transfer the whole branch) and can break the manifest→source/lockfile
dependency shape. Instead, *corpus selection* prefers repos whose natural selected-set size is
≤ ~500 files for C1/C2/C5; C3/C4 keep their natural (large) sets and §4.8's feasibility protocol
absorbs it. Whatever the production selection selects, every driver resolves in full.

**C4 runs the production designs, not idealisations.** On a truncated tree, T0 and T1 both fetch
the REST tree, observe `truncated: true`, and take the existing checkout-clone fallback
([orchestrate.ts:823](../../scripts/orchestrate.ts#L823)) — exactly as production routes today and
as Option 1 retains. T2a clones with checkout by definition; T2c takes its `--no-checkout` +
`ls-tree` path. The discriminating comparison on C4 is therefore {REST tree attempt + checkout
clone + walk} vs {no-checkout clone + ls-tree + cat-file}, and every driver resolves the same
workload, so the scenario aggregates comparably. Because T0/T1 materialise a checkout here, the
§4.5 gitconfig probe applies to them on C4 exactly as it applies to T2a everywhere.

### 4.3 Workload pinning and ground truth

At pinning time, once per corpus unit (repo × branch):

1. **Pin the bench configuration** as a committed artifact (`bench-config.json`): the
   tracked-package set, exclusion globs, CLI-classifier terms, size-gate constants, T1 caps and
   failure-policy constants (§4.4), the driver-order schedule (§4.5), and the exact scaffolding
   argv tuples. The workload is a function of (config, repo, SHA) and all three are pinned.
2. Run the production selection logic (manifest location → lockfile election → source/CLI gates)
   against the pinned SHA via the status-quo path, recording the final selected set: `{path, mode,
   blobOid, size, class}` per entry, committed under `selected/`.
3. Record ground truth per entry as a **route-expectation matrix**: for each driver, the declared
   route (primary | symlink-fallback | binary-lockfile-skip | truncated-fallback) and the expected
   *seam-level string* (sha256 of the UTF-8-decoded bytes that route delivers — REST-dereferenced
   bytes for symlink fallbacks, decoded blob bytes elsewhere), plus the canonical blob-bytes hash
   for raw-capable verification (T1 hash-validated text; T2c pre-decode frames). Symlink REST
   expectations are deterministic because the dereference target is pinned by the same commit.
   Pinning tooling is unconstrained (full local clone, plain git; not a measured activity).

### 4.4 Drivers

| Driver | Option | Shape |
|---|---|---|
| T0 | Status quo | REST `contents` per file, production Accept header, production concurrency semantics, production throttle classification |
| T1 | Option 1 | Aliased GraphQL blob batches under **fixed pre-declared caps and failure policy**; two-round dispatch exactly as the production design forces; per-alias hash validation; symlink/binary/truncated → REST fallback, counted |
| T2a | Option 2a | Option 2a *as considered in the ADR*: shallow clone + checkout, `ls-tree` enumeration for modes and paths, working-tree reads for regular blobs, mode-routed symlink policy (REST fallback), head-coherence check |
| T2c | Option 2c | §3.1 exactly: no-checkout acquisition, `ls-tree -r -z -l`, per-round `cat-file --batch` with concurrent-pump framed reads, seam-level UTF-8 decode |

**Drivers implement the considered designs, minimally.** Each driver is the minimal faithful
implementation of its option as evaluated in the ADR — including the parts today's code lacks.
T2a's mode source is `ls-tree`, not `lstat`: the ADR's own Option 2a analysis says a correct
symlink policy "needs index/tree modes", `lstat` cannot identify links under `core.symlinks=false`,
and reading modes from committed fixture metadata would be circular. That prices the `ls-tree` verb
and parser into **both** clone options' ledgers — a real finding about 2a's true cost, recorded in
the §5 ADR edits.

**T1's failure policy is fixed before the matrix, not improvised during it.** Declared in
`bench-config.json`: caps — alias 250 (M2's measured point), query-document 48 KiB, per-batch
content estimate 1.5 MiB (deliberately below M5's 3.0 MB single point, which ran at half this alias
cap; the alias×content interaction is unmeasured, so the matrix cap keeps margin and the §4.4
boundary probe maps the interaction), argv 128 KiB. Failure policy — transient 5xx: bounded retry
per the production attempt limit, never split on first failure; split trigger: structured timeout
evidence or two consecutive size-correlated 5xx on the same batch; binary split with descendant
depth ≤ 2 and a descendant cap of 4 per original batch; circuit breaker: 3 consecutive failed
dispatches abort the unit (a G2/G3 event); per-unit REST fallback budget: max(20, 10% of selected),
exceeded → unit failure; partial responses: per-alias resolution via `data` + `errors[].path`, an
alias absent from both retried once at batch level then routed to fallback (counted).

**Clone acquisition is SHA-pinned; the production argv is validated at pinning.** `git clone
--branch` takes a ref name, not a SHA, so a branch that advances after pinning would make T2a
silently scan a different commit and T2c fail its own coherence gate — the workload would drift
under the benchmark. Timed acquisition therefore is, exactly:
`git init --template= <dir>` → `git remote add origin <url>` →
`git fetch --depth 1 --no-tags --no-recurse-submodules origin <sha>` →
(T2a only) `git checkout --detach FETCH_HEAD`. T2c performs no checkout and addresses objects by
the pinned SHA directly — `ls-tree -r -z -l --full-tree <sha>`, `rev-parse FETCH_HEAD` asserted
equal to `<sha>` — because a bare fetch updates only `FETCH_HEAD` and leaves no `HEAD` to resolve
(the production form's `HEAD`-based coherence check is exercised in the pinning-time validation
run). Equivalence to the production single-`clone` form is validated at pinning while the live head
still equals the pinned SHA: run the production `cloneShallow` argv once per clone driver;
assert identical tip commit and tree OIDs and an **identical object set** (`git rev-list --objects
<sha>`, sorted and hashed, in both directories — pinning tooling is unconstrained); record both
wall times side by side in `report.md`, flagging any gap over 10% so the acquisition-form delta is
visible to the decision-maker rather than folded silently into T2a/T2c timings. If a pinned SHA
later becomes unreachable (force-push), the fetch fails loudly and the slot is re-pinned — never
silently re-resolved.

**Option 3 is not a driver.** It is evaluated the way the ADR already recommends: an offline
duplicate-OID analysis over the corpus trees (cheap, no network), reported alongside — plus one
warm-run scenario (advance C1 one commit, re-run the winning driver with and without OID keying)
to quantify what Option 3 would add *compositionally*.

**Boundary probe (informational, post-matrix).** A two-dimensional sweep on one mid-size repo:
alias counts {250, 300, 350, 400, 425, 450, 475} at small fixed content, and alias×content pairs
{150, 250} × {1.5 MiB, 3 MiB}, 3 tries per cell — mapping the failure boundary, testing whether
M4's 462-alias 502 is deterministic, and probing the alias×content interaction the fixed caps
deliberately stay clear of. Not scored; evidence for the production caps ADR-0001 requires.

### 4.5 Protocol

- **K = 5** repetitions per (performance-corpus unit × driver). A *run* is: fresh temp dir, empty
  cache DB, resolve every workload entry, tear down. The bench temp prefix is **`pa-bench-*`** —
  deliberately *not* prefixed `pkg-audit-`, because the production startup sweep deletes every
  `pkg-audit-*` entry unconditionally ([github.ts:2096](../../scripts/github.ts#L2096)) and would
  reap live benchmark directories.
- **Ordering:** driver orders are a preregistered table in `bench-config.json`: repetitions 1–4
  follow a Williams design (digram-balanced Latin square — each driver once in each position, each
  ordered predecessor pair exactly once), so no driver systematically inherits another's
  server-side pack-cache warmth or time-of-day drift; repetition 5 is a fifth preregistered order
  chosen to minimise repeated digrams, with the residual imbalance stated in the report.
- **Cold** means: no `api_cache` rows, no reused clones, no HTTP cache. DNS/TLS warmth is ambient
  and shared.
- **Completion discipline:** eligibility requires all K runs complete (G3). One rerun per
  (unit, driver) is permitted only for an **objectively external** failure: a network-layer error
  outside any HTTP response (DNS/TLS/connect/reset), or an HTTP 5xx on a request that was within
  all declared caps *and* whose request class succeeded in at least one other repetition. A
  cap-exceeding batch's 5xx, a guard rejection, a parse failure, or a coherence failure is a
  driver failure — no rerun. Failed attempts always stay in `runs.jsonl` and count in the failure
  metrics; the replaced attempt's timing is excluded from throughput aggregation (it resolved no
  complete workload) and the rerun's timing enters it.
- **Checkout-config probe:** every run that materialises a checkout — T2a on all units, T0/T1 on
  C4 via the truncated-tree fallback — gets one additional repetition under `core.autocrlf=true`
  (matrix reps run `false`). Any seam-level byte divergence between the two configs on the same
  entry is a G1 determinism failure, with the diff attributed. The claim this probe supports is
  config-dependence within the pinned bench environment — one demonstrated divergence makes the
  ADR's byte-determinism objection concrete; cross-platform invariance is not claimed by anyone.
- **Concurrency probe (informational, API drivers).** The serial matrix cannot observe the shared
  REST/GraphQL secondary limits that concern Option 1's scheduler. After the matrix: run C1's four
  branch units as 4 concurrent streams for T0 and for T1, recording every secondary-limit signal.
  Results are reported, not scored — they evidence the scheduler requirement, they do not rank
  drivers.
- Each run records `rate_limit` headroom before/after (both `core` and `graphql` buckets) and every
  secondary-limit signal, classified as production does
  ([github.ts:541](../../scripts/github.ts#L541)): header-signalled 429/`retry-after`,
  body-signalled 403 secondary-limit responses, and GraphQL `RATE_LIMITED` error codes.

### 4.6 Metrics, per run

1. Wall time (workload start → last entry resolved; for §4.8 segmented runs, the sum of segment
   walls, with inter-segment sleeps excluded and the segment count reported).
2. HTTP requests by class: REST content, REST tree, REST fallback, GraphQL requests; GraphQL
   points as the *measured* `rateLimit { cost }` sum, never the formula.
3. Transfer, reported as two explicitly non-comparable kinds: HTTP body bytes (API drivers) and
   on-disk object-store bytes after acquisition (`du` over `.git/objects`, clone drivers — labelled
   on-disk, since git reports no clean transfer-byte figure without packet tracing).
4. Peak disk under the run's temp dir.
5. Failures: 5xx, timeouts, retries (attempt-counted), fallback count by cause (symlink, binary,
   truncated, batch-error), incomplete entries, secondary-limit signals by kind, rerun usage with
   recorded cause.
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

**Eligibility is global per driver** — a driver that fails any gate on any performance-corpus unit
is ineligible, full stop. Per-unit exemptions would let hard scenarios quietly vanish from the
comparison, and an option that cannot handle a scenario class is exactly what the gates exist to
surface. The gates:

- **G1 Determinism/fidelity:** delivered strings match the route-expectation matrix for every
  entry in all reps; raw-capable verification passes where declared; no divergence under the
  checkout-config probe. A driver whose policy cannot state expected bytes machine-independently
  fails G1 by construction; the measured divergence is the evidence.
- **G2 Completeness:** every workload entry resolves via its declared route; a whole-batch failure
  surfacing as silent per-entry absence is a G2 failure, not a fallback; fallback-budget
  exhaustion and circuit-breaker aborts are G2 failures.
- **G3 Stability:** all K reps complete, within the §4.5 rerun discipline.
- **G4 Envelope:** peak disk ≤ 2 GiB per unit (ratifiable constant). Secondary-limit conduct is
  pass/fail: more than one secondary-limit signal (any kind) attributable to a driver's own
  admission behaviour across the whole matrix fails G4; exactly one is a recorded warning and the
  affected run may use the rerun allowance. Signals during the unscored concurrency probe do not
  count against eligibility — that probe exists to elicit them.

**Comparison (symmetric — no incumbency margin):** per performance-corpus unit, compare eligible
drivers' throughput; differences within a **1.25× noise band** are a tie for that unit (five
network-bound reps cannot resolve finer). This yields a per-unit win/tie/loss table. A driver
**dominates** when, against every other eligible driver, it has at least one unit-win and no
unit-losses.

The round-1 draft's 2.0× incumbent-displacement margin is withdrawn: both finalists are equally
unimplemented, so there is no incumbent in any engineering sense, and an uncalibrated asymmetric
constant is exactly the thumb on the scale D2's resolution must not contain. Design-surface
differences are not priced into the rule; they are the decision-maker's judgment, exercised on the
ledger (§3.3) alongside the measurements.

**Case mapping, exhaustive:**

- ≥2 eligible, one dominates → the rule recommends the dominator.
- ≥2 eligible, no dominator → no recommendation; the full table goes to the decision-maker.
- Exactly 1 eligible → the rule recommends it, with every other driver's disqualifying evidence
  attached.
- 0 eligible → no recommendation; the failure evidence itself is the finding, and the ADR cannot
  move to `accepted` on this benchmark.

**Who decides, symmetrically:** the decision-maker (rvo) makes the ADR decision in every case —
ratifying the rule's recommendation or overriding it. Two hard constraints: an **ineligible driver
can never be chosen** (its gate failure is disqualifying under the ADR's own decision drivers), and
**every Step-D outcome — ratification, override, or no-dominator judgment — passes one further
adversarial review round before the ADR flips to `accepted`**, with any override's written
rationale recorded in the ADR's Review history. No path to `accepted` skips review, in either
direction.

### 4.8 Budget, feasibility, and safety

- API spend estimate is corpus-dependent once C3/C4's natural selected sets are known at pinning;
  the harness computes and prints it before running. The harness is **bucket-aware and
  resumable**: before each run it reads `rate_limit` and proceeds only if
  `projected-spend × 1.5 ≤ headroom` for every bucket the run touches — otherwise it sleeps to the
  reset epoch. Sleeps happen *between* runs, never inside one; partial results persist and resume.
- **Feasibility gate:** if a single run's `projected-spend × 1.5` exceeds a bucket's *full
  capacity* (5,000), no reset can ever satisfy the guard — the wait would be infinite. Such runs
  (realistically: T0 on a C4-scale unit) execute in **segmented mode**: the workload is split into
  pinned contiguous segments each satisfying the guard, segments run in successive bucket windows,
  the clock pauses between segments (§4.6), and the segmentation is reported. For such units the
  bucket-ceiling term dominates the throughput headline regardless, so segmentation noise cannot
  flip the comparison; the report states this where it applies.
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
4. **Option 2a's section** gains the mode-source correction: a faithful 2a needs `ls-tree` (or
   equivalent index/tree mode access) for symlink routing — `lstat` cannot do it under
   `core.symlinks=false` — so the "new verb" cost previously attributed only to canonical reads is
   partly intrinsic to any correct clone option.
5. **Confirmation:** replace the four-line gate sketch with a summary of §4 and a link to this
   plan: corpus slots, drivers (2c included; Option 3 restructured to the compositional analysis),
   global eligibility gates, the symmetric 1.25× noise-band comparison with its exhaustive case
   mapping, and the universal one-round re-review of every Step-D outcome. The "predeclared
   margin" promise becomes an actual predeclared rule.
6. **Review history:** annotate the two disagreements with their resolution state, without erasing
   the original record: **D2 is closed by this PR** (the variant is now evaluated in-ADR as Option
   2c and benchmarked as T2c on a symmetric rule); **D1's resolution is committed by this PR and
   discharged at Step D** (spec now exists and is binding; the benchmark itself has not yet run,
   so the ADR remains `proposed` — which is the reviewer's position honoured).
7. **Follow-on work:** the canonical-object clone variant entry is superseded (now in-ADR); the
   tree-request-term entry gains "Option 2c eliminates this term; if Option 1 wins, the term
   survives and keeps its own ADR"; Option 3's entry gains the concrete measurement vehicle
   (§4.4's offline analysis + warm scenario).

## 6. Sequencing

| Step | Vehicle | Content | Closure state after step |
|---|---|---|---|
| A | PR #27 (this branch) | This plan + the §5 ADR edits. ADR stays `proposed`. | D2 closed; D1 committed, open until D |
| B | Follow-up PR | Harness, proposed-grammar module, framed-reader prototype, corpus pinning + verification, `bench-config.json` (caps, failure policy, schedule table, scaffolding argv), workload/ground-truth artifacts, planner unit tests. **Ratification (§8) happens here, before any timed run.** | D1 executable |
| C | Follow-up PR | The run: `runs.jsonl`, `report.md`, boundary probe, concurrency probe, Option-3 analysis, rule output. | D1 evidence complete |
| D | Follow-up PR | Decision per §4.7's case mapping, then **one adversarial review round on the decided ADR text — every outcome, every direction** — then status flip. | D1 discharged |

Steps B–D have no calendar deadline — the gate is evidentiary, not temporal.

## 7. Non-goals

- No production implementation of any option (no seam refactor in production code, no scheduler,
  no guard changes to `readOnlyGuard.ts` — the proposed grammars and the framed-reader prototype
  live beside the bench until an ADR adopts them).
- No CI job that talks to the network.
- No re-litigation of settled ADR content (the M-series measurements, the limits table, the
  fail-closed rules) beyond the §5 edits.

## 8. Ratification and freeze

Decision-maker sign-off, recorded in the harness PR **before any timed run**:

1. The 1.25× noise band and the dominance definition (§4.7).
2. K = 5, the 2 GiB per-unit disk gate, the G4 secondary-limit threshold, and the fixed T1 caps
   and failure-policy constants (§4.4).
3. Final corpus pinning after slot verification, including accepting C3/C4's natural workload
   sizes and their budget cost.
4. The symlink policy all drivers declare (REST-deref parity with today) — a findings-visible
   choice.

**Freeze semantics:** after ratification, any change to a pre-registered constant — gates, caps,
failure policy, corpus predicates, noise band, dominance definition, schedule table — invalidates
all previously collected timing data (the matrix restarts) and requires amending this plan plus
one adversarial review round on the amendment before new timing data is collected. Pre-registration
that can be edited mid-run is not pre-registration.
