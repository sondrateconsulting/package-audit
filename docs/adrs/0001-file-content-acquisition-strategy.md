---
status: "accepted"
date: 2026-08-03
decision-makers: rvo (repository owner)
consulted: Codex (gpt-5.6-sol / GPT-5.5) — successive adversarial review rounds through Step D; see Review history
informed: operators running `bun run audit` against large estates
---

# Lift the per-file REST rate-limit ceiling by acquiring file content from per-unit no-checkout clones (canonical-object reads via guarded cat-file)

## Context and Problem Statement

`package-audit` fetches file content one HTTP request per file — concurrently across branch units, but never batched within one. For each branch unit the
orchestrator fetches the recursive tree once
([orchestrate.ts:807](../../scripts/orchestrate.ts#L807)), then hands `scanUnit` an `apiReader`
([orchestrate.ts:111](../../scripts/orchestrate.ts#L111)) whose every cache-missing invocation is a
distinct `GET /repos/{org}/{repo}/contents/{path}?ref={commitSha}` call
([github.ts:1972](../../scripts/github.ts#L1972)).

### What actually gets read

`unitPipeline` reads a **selected subset** of the tree, through **two different gates**:

* **Manifests and lockfiles** are located and read *before* any size gate. `locateManifests` applies
  `excludeDirGlobs` and the `node_modules` rule but no size check
  ([manifest.ts:195](../../scripts/manifest.ts#L195)); manifests are read at
  [unitPipeline.ts:113](../../scripts/unitPipeline.ts#L113), and the deduplicated *nearest non-binary
  lockfile* is read only while iterating extracted facts
  ([unitPipeline.ts:137](../../scripts/unitPipeline.ts#L137)) — so a unit with no tracked dependency
  reads no lockfile at all.
* **Source and CLI files** additionally pass a 2 MiB cap and the exclusion rules in the scan loop
  ([unitPipeline.ts:185](../../scripts/unitPipeline.ts#L185)). Source files also require a non-empty
  resolved tracked-package set ([unitPipeline.ts:190](../../scripts/unitPipeline.ts#L190)). The CLI
  classifier is [cliScanner.ts:124](../../scripts/cliScanner.ts#L124): `package.json`,
  `*.sh`/`*.bash`, `.github/workflows/**` `.yml`/`.yaml`,
  `Dockerfile`/`*.Dockerfile`/`Containerfile`, `Makefile`/`makefile`/`*.mk`.

### The cost model, stated precisely

A content read's cache identity is effectively **`(host, org, repo, path, commit SHA, Accept
variant)`** — `cacheKey` composes host and endpoint
([github.ts:1358](../../scripts/github.ts#L1358)) over rows keyed `(method, url, variant_hash)`
([db.ts:386](../../scripts/db.ts#L386)). Against that identity, three effects reduce requests:

* A SHA-pinned repeat is served with **zero network** ([github.ts:1508](../../scripts/github.ts#L1508)).
* A branch skips `processUnit` when its unit is already `done` for this config *and* its stored head
  equals the live head — not merely because the branch is unchanged
  ([orchestrate.ts:675](../../scripts/orchestrate.ts#L675)).
* Branches on the *same* commit share rows.

And three push them back up:

* **Non-cacheable responses repeat.** Only an exact 200 persists
  ([github.ts:1586](../../scripts/github.ts#L1586)), so a 404 is never cached; `apiReader` maps it to
  `null` and the CLI pass can re-request the same `package.json`
  ([unitPipeline.ts:202](../../scripts/unitPipeline.ts#L202)). (Raw content rows are *not* tombstoned
  — tombstoning is confined to JSON and tree responses,
  [github.ts:1606](../../scripts/github.ts#L1606), [github.ts:1967](../../scripts/github.ts#L1967).)
* **Concurrent duplicate misses.** The cache is read before the network await
  ([github.ts:1507](../../scripts/github.ts#L1507)) with no single-flight coalescing, so sibling units
  in the same pool ([orchestrate.ts:660](../../scripts/orchestrate.ts#L660)) can both miss and both
  fetch.
* **Retries**, up to `MAX_ATTEMPTS` ([github.ts:1000](../../scripts/github.ts#L1000)).

So **requests ≈ distinct cold content identities + repeated non-cacheable responses + concurrent
duplicate misses + retries**. On a cold estate the first term dominates and approaches the number of
selected files — approaches, not equals, because same-commit branches still share rows.

GitHub's primary REST limit for ordinary, non-qualifying user authentication is **5,000 requests per
hour** (qualifying GHEC-owned App/OAuth calls get 15,000 — see the table in
[More Information](#more-information)). A modest
engagement — 20 repos × 4 branches × 300 selected files ≈ 24,000 requests — needs four bucket
replenishments beyond the first full bucket; the resulting wall time depends on reset alignment and
on scan time, and is on the order of hours rather than minutes.

The tool handles the wall correctly — §4 classifies the throttle
([github.ts:541](../../scripts/github.ts#L541)), sleeps to the reset epoch, defers via
`requeue-throttle` — but that **paces and defers the cost; it does not reduce it**.

Two further facts shape the options. The clone fallback already exists but runs only on a *truncated*
tree ([orchestrate.ts:823](../../scripts/orchestrate.ts#L823) → `cloneShallow`,
[github.ts:2024](../../scripts/github.ts#L2024)) — i.e. only past GitHub's 100,000-entry / 7 MB cap,
which selects for the largest repositories. And GitHub's repository payload carries a `size` field
(kilobytes) that `RepoInfo` does not model ([github.ts:810](../../scripts/github.ts#L810)) — the local
type lacks it; the field's existence is a property of GitHub's repository schema.

**Question:** how should `package-audit` acquire file content so a large-estate cold run is fast and
stable, and stays inside every applicable GitHub limit?

**Scope.** The target is the content-read path — the `ReadFile` seam
([unitPipeline.ts:46](../../scripts/unitPipeline.ts#L46)) and its `apiReader`/`cloneReader`
implementations — but every option below reaches further, and each states exactly which components it
touches. Registry introspection and the report/export layers are unchanged throughout.

### Measured baseline

**Single-sample, indicative, not statistical.** Live GitHub, 2026-07-27, this repo's `gh`
credentials: no repetition, no p50/p95, no pinned corpus, workloads deliberately not identical.

| # | What | Workload | Requests | Cost | Wall time |
|---|---|---|---|---|---|
| M1 | REST `contents` per file (status quo, **derived not run**) | 481 whole-tree files | one request per *selected* file | 481 nominal successful-path requests, excluding retries and repeated non-cacheable reads | not measured |
| M2 | Aliased GraphQL blob batch | 250 selected blobs, 633 KB | 1 GraphQL | **1 point**, `nodeCount: 0` | 8.1 s |
| M3 | Aliased GraphQL blob batch | 400 selected blobs, 941 KB | 1 GraphQL | **1 point** | 9.2 s |
| M4 | Aliased GraphQL blob batch | 462 selected blobs (~72 KB query) | 1 GraphQL (failed) | — | **HTTP 502** |
| M5 | Aliased GraphQL blob batch | 125 blobs, 3.0 MB (large `.md`) | 1 GraphQL | **1 point** | 4.7 s |
| M6 | `git clone --depth 1 --single-branch --no-tags` — **note: not the full production argv, which also carries `--branch <b>`, `--no-recurse-submodules`, `--template=` and the pinned gitconfig** ([github.ts:2024](../../scripts/github.ts#L2024)) | 481 files, whole tree, 4.8 MB | **0 REST** | `core.used` delta **0** | 0.715 s |
| M7 | Blobless clone + sparse checkout | 227-path sparse cone | **1** `git fetch --filter=blob:none --stdin` subprocess observed | 0 REST | not timed |
| M8 | `git fetch --depth 1 origin <branch>:refs/remotes/origin/<branch>` into an existing shallow clone | 2nd branch of a 125-file repo | 0 REST | `in-pack` count unchanged | 0.766 s |
| M9 | **Symlink divergence** (below) | one mode-`120000` entry | — | — | **2,513 bytes vs 17 bytes** |

**What these do and do not prove.** M2/M3 fetch a *selected* subset while M6 fetches a *whole tree*,
so no speed ratio between them is quoted. Option 3 was not measured in this series (its
compositional analysis later ran at Step C; see Confirmation and Follow-on work). M7's `pack_header=2,227` means
pack format **version 2 containing 227 objects** — not 227 blobs — so only the single-subprocess
observation is claimed, and it does not generalise to arbitrary access patterns. M8's unchanged
`in-pack` count does not prove full object reuse: loose objects are counted separately and small
fetches may arrive unpacked. M6 was not run with the production argv or environment.

M2/M3 are **client wall time**, not server processing time; against the documented 10-second threshold
they show roughly **1.9 s and 0.8 s of client-observed headroom**. M4 is **one failed request** —
consistent with a timeout, but one sample cannot establish that a size-induced 502 is deterministic.

**M5 vs M3 shows byte count alone is not a sufficient sizing predictor.** M5 moved 3.0 MB across 125 aliases
in 4.7 s; M3 moved 941 KB across 400 aliases in 9.2 s.

**M9, in full, because it fixes the byte-semantics requirement every option is measured against**
(it decided this ADR against checkout-based reading — Options 2a/2b; Option 2c reads canonical
objects and passes the same standard). Path
`deps/v8/third_party/ittapi/ittapi-rs/CMakeLists.txt` in `nodejs/node` at
`b2a024b1ad3373d405ca55af23f59dd4cd696c2f`; tree entry `mode=120000 type=blob size=17
sha=de0cf227139ff67dd6d0493c03533e48d6ea8634`.

* REST Contents with production's `Accept: application/vnd.github.raw+json`
  ([github.ts:999](../../scripts/github.ts#L999)) returns **2,513 bytes** — the *dereferenced target's*
  content.
* GraphQL `object(expression:)` returns **17 bytes** (`../CMakeLists.txt`), `__typename=Blob`,
  `byteSize=17`, `isBinary=false`.
* `printf '../CMakeLists.txt' | git hash-object --stdin` yields `de0cf227…` — **exactly the tree OID**.
  GraphQL therefore returns the canonical git object the tree names; REST returns bytes that are *not*
  the object at that OID.
* `walkClone` skips symlinks entirely ([orchestrate.ts:151](../../scripts/orchestrate.ts#L151)).

All three transports disagree on symlinks, and the tree's `size` describes the link, not what REST
returns. **A symlink policy must be chosen explicitly by whichever option wins.**

## Decision Drivers

* **Reduce the cold-run request count.** Pacing and deferral do not count.
* **Respect every applicable limit** — a goal, not a guarantee: several relevant secondary limits are
  shared across REST and GraphQL with undisclosed thresholds, so no design here can prove compliance.
* **Preserve the evidence guarantees, and make any change to findings explicit and tested.**
  Commit-pinned attribution, the fail-closed rule at
  [orchestrate.ts:111-121](../../scripts/orchestrate.ts#L111), the read-only guarantee in
  [readOnlyGuard.ts](../../scripts/readOnlyGuard.ts), and — the property this decision turns on —
  **deterministic, per-entry control over which byte semantics a path resolves to**, verifiable from
  inside the tool. Note this is *control*, not "always the canonical object": today's `apiReader`
  deliberately returns REST's dereferenced bytes for a symlink, and preserving that is a legitimate
  choice. What matters is that the tool decides, and can prove which semantics it got.
* **Bounded resource envelope**, owned by the chosen option rather than used only to reject others.
* **Proportionate and containable change.** Prefer new surface that is in-process and testable over
  surface that touches the filesystem, other processes, or platform-dependent behaviour.

## Considered Options

* **Option 1 — Batched blob reads over the GraphQL API**, retaining the existing per-branch clone for
  truncated trees
* **Option 2a — Promote the existing per-unit shallow clone** to the default content path
* **Option 2b — Shared partial/sparse/multi-ref repository per repo**
* **Option 2c — Per-unit clone without checkout, canonical-object reads via guarded `git cat-file`**
* **Option 3 — Content-addressed blob cache** keyed on blob OID

## Decision Outcome

Chosen option: **"Option 2c — Per-unit clone without checkout, canonical-object reads via guarded
`git cat-file`"**, because the pre-registered pre-acceptance benchmark ran to completion and its
§4.7 rule output was **exactly one eligible driver → recommend T2c** (the driver implementing
Option 2c), and the decision-maker ratified that recommendation on 2026-08-03. The question as
asked, the verbatim answer, and the disclosures accompanying the ask are recorded in the §8
record's Step-D entry ([ratification.json](0001-benchmark/ratification.json)); the evidence is the
committed Step-C set ([report.md](0001-benchmark/report.md) with `runs.jsonl`, `fidelity.jsonl`,
the probes and `option3.json`), collected at frozen-surface digest `8b67a314…`.

**What the rule found** (report §2; the eligibility gates are global per driver, spanning the
performance corpus and the fidelity battery, and the disqualifiers below are route-specific):

* **T2c is eligible.** G1–G4 pass: both fidelity fixtures pass, zero attributable secondary-limit
  signals, maximum sampled-peak disk 293.3 MiB (on C4, the truncated-tree unit).
* **T0 (status quo) and T1 (Option 1) are ineligible.** G1: their delivered strings mismatched
  the pinned non-UTF-8 fixture — T0 on its REST primary route, T1 via its validation-fallback
  route (a GraphQL response failing the pinned validation, falling back to REST) — while the
  clone-path deliveries matched it. G4: sampled-peak disk ~2.6 GB against the ratified 2 GiB
  gate on C4 rows, where the truncated tree routes both onto the retained checkout-clone
  fallback. Both passed G2 and G3, with zero attributable secondary signals.
* **T2a (checkout clone) is ineligible.** G1: the checkout-config probe exhibited `autocrlf`
  materialisation divergence on seven probe rows (13–1260 diverging deliveries each) — the
  byte-determinism objection this ADR raised against checkout reads, measured rather than
  argued. G4: the same C4 checkout disk. It too passed G2 and G3 with zero signals.

**What the decision rests on, and what it does not.** The recommendation is the rule's
sole-eligible case, not a throughput verdict: under the ratified 1.75 noise band T2c led or tied
every unit, but that reading is informational — T1's raw C5 median was higher (61,912 vs 36,657
files/hour, a tie under the band), and dominance was never evaluated, since no rival was
eligible. M9's hash check remains the historical measurement that fixed the byte-semantics
requirement every option was judged against; the benchmark's fidelity battery and checkout-config
probe carried that requirement into the gates that decided this. The evidence is a per-scenario
serial cost profile, not an estate simulation: concurrent fan-out, the shared REST+GraphQL budget
under contention, cross-unit cache effects, and aggregate clone disk across parallel units remain
design-ledger items — the concurrency probe evidences them (4 concurrent streams, zero secondary
signals) without scoring them.

**This is not a drop-in transport swap.** The resolution plan's §3.1 definition and §3.2 ledger
are the normative implementation bill, in two classes:

1. **Specified constraints** — the shape the implementation must have: three new `readOnlyGuard`
   grammars (a second exact clone shape carrying `--no-checkout`; the `ls-tree -r -z -l
   --full-tree` tuple; a `cat-file --batch` tuple with `--textconv`/`--filters` structurally
   absent); the stdin trust boundary confined by a writer that emits only format-validated OIDs
   (40-hex SHA-1 / 64-hex SHA-256, per the repository's object format); the framed binary spawn
   seam (bounded pre-LF headers, frame sizes bound to the ls-tree-declared size under the
   absolute ceiling, capped stderr, streaming consumption); the unit-lived child lifecycle —
   lazy spawn, per-read deadlines, at most one respawn, ordered teardown before clone deletion —
   drawing from its own small fixed permit pool, never the subprocess semaphore; the
   `GIT_NO_REPLACE_OBJECTS` addition to `buildGitEnv`'s allowlist (silently dropped today); head
   coherence against the discovery-pinned OID; the 2 MiB gate reading canonical `ls-tree` sizes;
   and the ratified symlink policy — mode-`120000` entries resolve via the REST dereference
   fallback, preserving today's findings, the canonical link payload staying a latent capability.
2. **Residual risks** — carried into implementation for remediation or explicit acceptance,
   never silent inheritance: the unowned `pkg-audit-*` startup sweep
   ([github.ts:2096](../../scripts/github.ts#L2096)); the single-attempt clone with no retry
   ([github.ts:2031](../../scripts/github.ts#L2031)); git-transport pacing (15 ops/s/repo,
   recommended not enforced, with no headroom header); and disk on the common path, whose
   aggregate under concurrent fan-out the benchmark did not measure.

**Byte semantics under the chosen option.** Regular-blob reads are the committed objects
themselves, self-verifying against the tree OID before any seam decode; `.gitattributes` never
executes. The `ReadFile` seam remains a string contract: 2c applies the same UTF-8 decode at the
seam that the REST path applies today, for findings parity — the transport's lossiness is
removed, and raw-byte consumers stay future work. Symlinks are mode-routed to REST's dereferenced
bytes (the ratified policy), so symlink reads still spend API budget. There is no truncation
cliff — `ls-tree` enumerates any tree — so the truncated-tree checkout-clone fallback and its
checkout-byte caveat retire on this path once the implementation lands; until then production
keeps today's routing.

### Consequences

* Good, because the content path's API cost drops to zero for regular blobs — no REST `contents`
  requests, no GraphQL points, and no per-unit REST tree request either (local `ls-tree`
  enumeration), with no 100,000-entry / 7 MB truncation cliff. Measured: T2c's median API
  consumption across the matrix was zero on every unit except C3, whose one counted fallback read
  cost one core unit (report §1's consumption table).
* Good, because the bytes on the primary path are the committed objects, verified against the
  tree OID before the seam decode — the property this decision turned on, held by construction
  rather than by validation of a remote response.
* Good, because the measured envelope held: 293.3 MiB maximum sampled-peak disk per unit
  (pack-only stores), zero attributable secondary-limit signals across the matrix and the
  4-stream concurrency probe.
* Bad, because the common path now touches disk on every unit and transfers the whole branch
  pack however few files are selected. The per-unit peak is an observation from the pinned
  corpus, not a bound, and aggregate disk under concurrent fan-out is unmeasured.
* Bad, because the new surface is real: guard grammar growth, the stdin trust boundary, the
  interactive-child lifecycle with its second permit pool, and the framed binary seam — the
  §3.2 ledger's honest price, now an implementation obligation rather than a hypothetical.
* Bad, because symlink reads still spend the per-unit REST fallback budget (max(20, 10% of
  selected)), so symlink-heavy units keep an API dependency and its failure modes.
* Neutral, because operational hardening is deferred to implementation **by name**, not
  silently: clone retry policy, pacing under fan-out, and the sweep-ownership fix (the
  residual-risk list above).
* Neutral, because OID-keyed content caching (Option 3) composes with API read paths, not this
  one: the frozen warm pair measured 255/255 cache hits with the wall unmoved (1260 → 1274 ms)
  — cross-run object reuse would be a persisted shared store, a different architecture, not a
  cache layer over this driver.

### Confirmation

**The pre-acceptance gate ran and is discharged.** The benchmark specified to execution level in
the [resolution plan](../plans/adr-0001-disagreements-resolution.md) — six-slot pinned corpus,
four drivers, preregistered constants and ordering, global eligibility gates spanning the
performance corpus and the fidelity battery, the symmetric no-incumbency-margin comparison rule —
was ratified and frozen at Step B (§8; PR #29), executed at Step C (PR #32), and decided at
Step D. Its §4.7 rule output — exactly one eligible driver → recommend T2c, with every rival's
disqualifying evidence attached — is recorded in [report.md](0001-benchmark/report.md) §3, and
the decision-maker's ratification of it (2026-08-03: the ask, the verbatim answer, and the
disclosures) in the §8 record's Step-D entry. Every Step-D outcome carries one further
adversarial review round before the ADR changes state; this decision's round is recorded in the
same entry. Every MEASURED number in the table above is single-sample and M1 is derived rather
than run; the executed benchmark supersedes them as decision evidence.

Post-implementation checks (the implementation PR must demonstrate these, not assert them):

1. **Guard grammars.** Accept/reject tables for the three new tuples — the `--no-checkout` clone
   shape, `ls-tree -r -z -l --full-tree <rev>`, and `cat-file --batch` — with
   `--textconv`/`--filters` structurally absent from the grammar, not merely unused.
2. **Stdin containment.** The `cat-file` writer emits only format-validated OIDs in the
   repository's object format (SHA-1 and SHA-256 both covered; mixed-format listings rejected);
   malformed, truncated, and non-OID inputs are refused, with tests driving each rejection.
3. **Framed reads.** `--batch` frame parsing validates OID echo, type, and size against the
   ls-tree-declared value under the absolute ceiling; a `<oid> missing` reply for an OID the
   unit's own enumeration listed fails the unit closed — never the seam's benign `null`; pre-decode
   frame bytes hash to the tree OID before the UTF-8 seam decode.
4. **Environment and coherence.** `GIT_NO_REPLACE_OBJECTS=1` is present in the child's sanitized
   environment (asserted — `buildGitEnv` drops unlisted variables), and `rev-parse HEAD` equals
   the discovery-pinned OID, else fail closed.
5. **Byte-level reader parity.** On raw reader output, not `UnitResult`: the M9 symlink
   (mode-routed to REST, must equal 2,513 bytes), a binary blob, a non-UTF-8 blob whose seam
   string matches today's REST delivery, a path containing a quote/backslash/newline/TAB, and a
   tree entry with missing or unknown mode (fatal, never treated as a regular blob).
6. **Child lifecycle.** Per-read deadline, the single-respawn policy, and ordered teardown —
   stdin close → exit await (kill-escalation on deadline) → disposer → clone deletion → permit
   release — on completion, failure, and abort alike.
7. **Two-pool discipline.** The child pool is a fixed small constant independent of unit fan-out;
   the deadlock test runs both pools at capacity 1 with a symlink REST fallback while a child is
   live; maximum configured fan-out spawns no more children than the pool size.
8. **Separated counters.** Local canonical reads, REST fallback reads by cause, fallback-budget
   spend, clone-transport operations, and retries as distinct metrics; the per-unit fallback
   budget (max(20, 10% of selected)) trips and terminates as defined.
9. **Operational hardening.** The clone retry policy and an owned temp sweep land with the
   implementation, or their explicit risk acceptance is recorded in the implementation PR; git
   transport stays under 15 ops/s/repo by construction, and the implementation shows its
   accounting for that.

## Pros and Cons of the Options

### Option 1 — Batched blob reads over the GraphQL API, retaining the existing per-branch clone for truncated trees

One request resolves many blobs, each a variable-bound `object(expression: "<sha>:<path>")` selection
returning `... on Blob { oid byteSize isBinary isTruncated text }` plus `__typename`.

* Good, because the request reduction is measured (M2, M3) at one point per batch.
* Good, because its hash-validated primary path returns **canonical committed bytes** (M9), with
  the symlink/binary/truncated exceptions explicitly routed to fallbacks.
* Good, because it reads only selected files — no whole-tree transfer, no working tree, no disk on the
  batch path.
* Good, because it requires no new `readOnlyGuard` verb.
* Neutral, because the two-round shape is forced by the pipeline's dependency order, not by batching.
* Bad, because its worst case is also `O(files)` REST via per-alias fallback.
* Bad, because it leaves the per-unit tree request on REST.
* Bad, because it adds a point floor the status quo does not have.
* Bad, because seam refactor, mode validation, batch client method, API-wide scheduler, admission caps,
  and cache provenance are all genuinely new work.

*Benchmark outcome (Step C):* T1 was ineligible under the pre-registered gates — G1 via its
validation-fallback delivery on the pinned non-UTF-8 fixture, G4 via the retained C4
checkout-clone fallback — with G2/G3 passing and zero attributable secondary signals
([report §2](0001-benchmark/report.md)). Not chosen. Earlier revisions of this document's
Decision Outcome specified Option 1's implementation bill to eight numbered items (batching seam,
mode validation, batch client method, API-wide scheduler, admission caps and failure policy,
per-alias fallback budget, query/response integrity, cache provenance); that specification lives
in this document's git history and would govern any future Option-1 adoption.

### Option 2a — Promote the existing per-unit shallow clone to the default content path

Flip the routing at [orchestrate.ts:823](../../scripts/orchestrate.ts#L823) so every unit clones, add a
size-based escape to `apiReader`, and enumerate locally with `walkClone` instead of fetching the tree.
**The faithful form of this option — the one the pre-acceptance benchmark evaluates as driver T2a —
replaces `walkClone`'s `lstat` enumeration with the same guarded `ls-tree` mode/size source Option 2c
introduces, mode-routes symlinks to the REST fallback, enforces head coherence, and keeps the
size-based `apiReader` escape under a preregistered threshold — with its oversized-and-truncated
hole exhibited by the benchmark rather than patched** (the bullets below establish why nothing less
is correct); what still distinguishes it from 2c is that the content *reads* are checkout bytes.

* Good, because git transport consumes **no REST budget** (M6), and local enumeration would drop the
  per-unit tree request too — the one term Option 1 leaves standing.
* Good, because clones are **per-unit and isolated**, so no branch-view, worktree, or multi-ref
  semantics are needed, and `cloneShallow`'s argv is already inside the guard's allowlist
  ([readOnlyGuard.ts:208](../../scripts/readOnlyGuard.ts#L208),
  [readOnlyGuard.ts:218](../../scripts/readOnlyGuard.ts#L218)).
* Good, because dropping `fetchTreeRecursive` is safe on this path: `TreeEntry.sha` has no consumer,
  `h.treeOid` feeds only the tree fetch, and cutoff/cap decisions come from GraphQL discovery
  ([branchPlanner.ts:37](../../scripts/branchPlanner.ts#L37)).
* Bad, and decisively, because **it cannot preserve committed bytes**. `checkout` applies
  `.gitattributes` transformations, so `cloneReader` bytes and `walkClone` sizes are attribute- and
  platform-dependent — which also perturbs the 2 MiB gate. Canonical reads need `cat-file`, excluded
  from the guard *by design* ([readOnlyGuard.ts:201](../../scripts/readOnlyGuard.ts#L201)). Accepting
  checkout bytes means accepting environment-dependent findings. (The *size-gate* half of this is
  fixable — canonical sizes via the same guarded `ls-tree` Option 2c introduces, at the cost of that
  verb; the checkout-read *bytes* are not fixable without becoming 2c.)
* Bad, because **the size router has no route for the oversized-and-truncated intersection**. Above the
  threshold it sends work to `apiReader`, which only reads paths it is handed
  ([orchestrate.ts:111](../../scripts/orchestrate.ts#L111)), while a truncated tree discards every path
  ([github.ts:744](../../scripts/github.ts#L744)). Those repositories must clone anyway, so the
  threshold does not bound the worst case without a new non-recursive subtree enumerator.
* Bad, because `size` is a **heuristic, not a bound**: it is repository-wide while the operation is a
  branch shallow pack plus an uncompressed checkout, and the listing may precede processing by hours.
  `walkClone` also accumulates an unbounded `TreeEntry[]`
  ([orchestrate.ts:140](../../scripts/orchestrate.ts#L140)), so memory needs its own limit.
* Bad, because **the disk lease collides with existing cleanup and with other processes**. The
  subprocess permit is released as soon as `git` exits ([github.ts:1288](../../scripts/github.ts#L1288))
  while the clone survives the scan; a failed cleanup only warns and leaves bytes behind
  ([orchestrate.ts:884](../../scripts/orchestrate.ts#L884)); and the startup sweep deletes every
  `pkg-audit-*` entry with no age, PID, or ownership check
  ([github.ts:2096](../../scripts/github.ts#L2096)), so a second concurrent audit can delete the first's
  live clones. Making every unit clone turns a rare hazard into the common path.
* Bad, because the **symlink policy is harder than "resolve within the root"**: containment accepts any
  target below the root, including `.git/config`, while `walkClone` excludes `.git` only at the
  traversal root ([orchestrate.ts:148](../../scripts/orchestrate.ts#L148)); GitHub dereferences only
  targets that are normal in-repository files; and on `core.symlinks=false` platforms links become
  ordinary text files that `lstat` cannot identify. A correct policy needs index/tree modes, lexical
  resolution through tracked entries, a tracked-regular-blob requirement, and gitlink exclusion — in
  practice the same guarded `ls-tree` mode source Option 2c needs, so a *faithful* 2a already pays
  part of 2c's verb cost.
* Bad, because **clone failures are not retried**: `cloneShallow` makes one attempt and converts any
  nonzero exit to `GithubApiError` ([github.ts:2031](../../scripts/github.ts#L2031)), and `processRepo`
  requeues only `ThrottleExhausted` ([orchestrate.ts:698](../../scripts/orchestrate.ts#L698)), so a
  transient network failure becomes a unit error. Git also offers no `x-ratelimit-remaining` analogue,
  only a recommended 15 reads/s/repository.
* Bad, because **commit coherence covers attribution, not planning**: cutoff and cap used the
  discovered `committedDate`, while the clone takes a mutable branch name, so a force-push can make the
  scanned commit unrelated to the eligibility decision unless `cloned.headSha === h.oid` is enforced.
* Neutral, because "it already exists" is true of the clone *command* but not of the design: the lease,
  router, enumerator, symlink resolver, retry policy, and pacing are all new.

*Benchmark outcome (Step C):* T2a was ineligible — G1 via measured `autocrlf` checkout divergence
under the config probe (seven probe rows, 13–1260 diverging deliveries each), G4 via the C4
checkout disk. The byte-determinism objection above is exhibited, no longer argued. Not chosen.

### Option 2b — Shared partial/sparse/multi-ref repository per repo

One repository-scoped object store with `--filter=blob:none`, sparse checkout, and additional branches
fetched into the same store.

* Good, because materialization batches (M7) and cross-branch object reuse is plausible (M8), which
  would beat 2a's per-branch re-transfer on many-branch repositories.
* Neutral, because it shares 2a's byte-fidelity, symlink, and disk problems unchanged.
* Bad, because there is **no branch-view model**: units run concurrently
  ([orchestrate.ts:660](../../scripts/orchestrate.ts#L660)) while `cloneReader` reads one working tree
  ([orchestrate.ts:128](../../scripts/orchestrate.ts#L128)), and fetching a ref does not make that
  directory represent another branch.
* Bad, because the **sparse path set cannot be computed up front**
  ([unitPipeline.ts:190](../../scripts/unitPipeline.ts#L190)).
* Bad, because a tree-derived sparse set can omit a file added on the newer clone HEAD while the unit is
  recorded as fully scanned at that SHA.
* Bad, because **`readOnlyGuard` rejects it**: `fetch`, `checkout`, `sparse-checkout`, `worktree` are
  outside the verb allowlist ([readOnlyGuard.ts:208](../../scripts/readOnlyGuard.ts#L208)) and
  `--filter`/`--sparse`/`--no-checkout` outside the clone option allowlist
  ([readOnlyGuard.ts:218](../../scripts/readOnlyGuard.ts#L218)).
* Bad, because it is strictly more work than 2a for an unmeasured benefit.

### Option 2c — Per-unit clone without checkout, canonical-object reads via guarded `git cat-file`

Clone exactly as 2a but with `--no-checkout`, so no working tree ever exists. Enumerate with a
guarded `git ls-tree -r -z -l --full-tree HEAD` — mode, type, OID, canonical object size, and path
for every entry. Read content through **one unit-lived `git cat-file --batch` child** (spawned with
`GIT_NO_REPLACE_OBJECTS=1`) serving the existing pull-style `ReadFile` seam: each read writes one
format-validated OID to stdin and reads exactly one framed reply. Added to this ADR after its
initial review rounds; full evaluation detail, including the benchmark driver specification, lives
in the [resolution plan](../plans/adr-0001-disagreements-resolution.md).

* Good, because reads are **the committed objects themselves** — self-verifying against the tree OID
  before any seam decode, the same guarantee Option 1's hash-validated path offers under M9's
  standard, with `.gitattributes` never executing at all.
* Good, because git transport consumes no REST budget (M6) **and** local `ls-tree` eliminates the
  per-unit REST tree request — the one term Option 1 leaves standing — with no 100,000-entry / 7 MB
  truncation cliff.
* Good, because the `ReadFile` seam survives unchanged: reads are local and on-demand, so Option 1's
  two-phase planning/consumption refactor does not exist here.
* Good, because symlink policy is mode-routed exactly like Option 1's (modes are explicit in
  ls-tree; no filesystem links exist to traverse), the 2 MiB gate reads canonical sizes rather than
  transformed `lstat` sizes, and binary bytes survive the transport natively — the seam's UTF-8
  decode becomes a deliberate parity choice instead of a transport loss.
* Neutral, because head coherence (`git rev-parse HEAD` against the discovery-pinned OID) is already
  allowlisted ([readOnlyGuard.ts:236](../../scripts/readOnlyGuard.ts#L236)) — the force-push guard
  costs no new verb.
* Bad, because `readOnlyGuard` grows three grammars: a **second exact clone shape** (every clone
  option is mandatory-exactly-once, [readOnlyGuard.ts:287](../../scripts/readOnlyGuard.ts#L287), so
  `--no-checkout` cannot join the shared set), an `ls-tree` tuple, and a `cat-file --batch` tuple
  with `--textconv`/`--filters` structurally absent — reopening a surface excluded by name today
  ([readOnlyGuard.ts:206](../../scripts/readOnlyGuard.ts#L206)).
* Bad, because `--batch` resolves arbitrary revs from stdin, which the argv guard cannot see:
  containment moves to a caller that must emit only format-validated OIDs (40-hex SHA-1 / 64-hex
  SHA-256, per the repository's object format). A genuinely new trust boundary — 2c's weakest point.
* Bad, because it needs a framed binary spawn seam — stdin piping, streamed length-prefixed frames
  bounded by the ls-tree-declared size under the existing spawn cap, bounded headers, capped stderr —
  where today's spawn is stdin-ignored and irreversibly UTF-8-decoded
  ([github.ts:168](../../scripts/github.ts#L168), [github.ts:180](../../scripts/github.ts#L180));
  and `buildGitEnv`'s allowlist drops `GIT_NO_REPLACE_OBJECTS` today, so the env addition is
  explicit new surface too.
* Bad, because a unit-lived child is a **new lifecycle class**: it cannot share the one-shot
  subprocess semaphore (holding a permit while the unit's symlink fallback awaits a REST permit
  deadlocks; sizing a per-unit pool instead composes to thousands of children at maximum fan-out),
  so it needs its own small fixed permit pool, lazy spawn, ordered teardown before clone deletion,
  per-read deadlines, and a respawn policy — every production subprocess today is one-shot.
* Bad, because `ls-tree -z` output is itself new parsing surface with a closed validation set:
  first-TAB record splitting (legal paths may contain TAB or LF), exact mode→type coherence over
  the closed mode set, object-format-length OIDs, bounded sizes, canonical unique valid-UTF-8
  paths failing closed, and bounded record/entry/stderr limits — none of which today's UTF-8
  line-splitting spawn consumers provide.
* Bad, because 2a's operational inheritance stands: disk on every unit (pack-only — smaller than
  2a, but the common path now touches disk where Option 1's does not), the unowned `pkg-audit-*`
  sweep hazard ([github.ts:2096](../../scripts/github.ts#L2096)), single-attempt clone, whole-branch
  transfer however few files are selected, and 15 ops/s/repo pacing with no headroom header.

*Benchmark outcome (Step C) and decision:* T2c passed every gate — the sole eligible driver —
and was ratified as the chosen option on 2026-08-03; see Decision Outcome.

### Option 3 — Content-addressed blob cache keyed on blob OID

Key reads and cache rows on blob OID, read through the existing, currently unused
`fetchBlobRaw(org, repo, blobSha)` ([github.ts:1983](../../scripts/github.ts#L1983)).

* Good, because it fixes a real inefficiency: a branch advancing one commit changes every selected
  path's `?ref=` and re-fetches content whose OIDs are unchanged.
* Good, because OIDs deduplicate across branches, forks, and vendored copies — including within a
  single cold run, where the second *sequential* occurrence of a duplicate OID is already a hit.
  (Concurrent occurrences can still both miss, for the same lack of single-flight noted above.)
* Good, because the change is modest: the `url` column is arbitrary text and the accessors take an
  arbitrary key ([db.ts:386](../../scripts/db.ts#L386), [db.ts:2361](../../scripts/db.ts#L2361)).
* Good, because it composes with any transport rather than competing.
* Bad, because it **does not bound the worst case**: when every selected OID is unique, a cold run pays
  the full per-file price. Its value depends on the estate's duplicate-OID ratio, which is unmeasured
  (the pinned corpus's ratio was measured at Step C — `option3.json` — but an operator's estate is its
  own question).
* Bad, because it leaves the per-file request *shape* intact, so secondary-limit and serial-latency
  pressure remain even at good hit rates.
* Bad, because **M9 makes naive OID caching unsafe**: for mode `120000` the tree OID names the 17-byte
  link payload while `contents` returns the dereferenced target, and a symlink's OID can stay constant
  while its target's content changes. Symlinks must be excluded from OID caching.
* Neutral, because the 304 exemption is not a differentiator: a SHA-pinned cached body returns locally
  before any conditional request ([github.ts:1508](../../scripts/github.ts#L1508)).
* Neutral, because unbounded growth is a pre-existing `api_cache` defect, and OID keys would *reduce*
  duplication.

## More Information

### Limits this decision is measured against

Retrieved 2026-07-27/28. Values are credential-, app- and host-specific; the tool supports arbitrary
GitHub Enterprise hosts and forwards `GITHUB_TOKEN` among other credentials
([github.ts:268](../../scripts/github.ts#L268)) — forwarding an environment variable does not
determine the credential *type*, so a PAT placed in `GITHUB_TOKEN` follows PAT limits while an
Actions-issued token follows its own. Response headers are authoritative, not this table.

| Limit | Value |
|---|---|
| REST primary (user-to-server / PAT) | 5,000 requests/hour |
| REST primary (GitHub Apps / OAuth) | 15,000/hour for Apps owned by a GHEC org, qualifying GHEC-owned/approved OAuth apps, and GHEC installation tokens; non-GHEC installations scale up to 12,500/hour |
| REST primary (Actions `GITHUB_TOKEN`) | 1,000 requests/hour **per repository**; 15,000/hour for enterprise-owned resources |
| REST secondary — request rate | "No more than 900 points per minute are allowed for REST API endpoints" (quoted verbatim; per-endpoint vs collective is ambiguous, and it is **not** immaterial — a burst can hit a per-minute limit long before the hourly primary is spent) |
| Secondary — concurrency | ≤100 concurrent requests, **shared across REST and GraphQL** |
| Secondary — CPU | ≤90 s CPU per 60 s real time, **shared**, of which ≤60 s may be GraphQL |
| Conditional `304` | Exempt from the **primary** REST limit when correctly authorized; secondary limits still apply |
| GraphQL primary | 5,000 points/hour for ordinary user/PAT auth, **including GHEC users**. 10,000 requires qualifying GHEC-owned App/OAuth calls or a GHEC installation; scaled non-GHEC installations reach 12,500; some `GITHUB_TOKEN` cases are as low as 1,000. **Every non-empty query costs ≥1 point.** Formula "subject to change" |
| GraphQL secondary | ≤2,000 points/minute for the GraphQL endpoint |
| GraphQL per-query timeout | **10 seconds**, after which GitHub terminates the request |
| GraphQL node limit | ≤500,000 nodes per query |
| GraphQL resource limits | Termination and **partial responses** under resource exhaustion are documented; the thresholds are not. Additional primary-point penalties may follow timeouts |
| Git read operations | Recommended maximum **15 operations/second/repository**; a recommendation, not an enforced limit with a headroom header |
| Recursive tree API | 100,000 entries or 7 MB, then `truncated: true`. GitHub still returns a *partial* `tree` array; **this client** deliberately discards it and surfaces only `{truncated: true}` ([github.ts:744](../../scripts/github.ts#L744)) |

GitHub's REST guidance is to issue requests **serially rather than concurrently** to avoid secondary
limits. Wider risks the secondary limits; narrower makes the hourly primary bind on wall time. Every
option here escapes by reducing request *count* rather than tuning request *rate*.

### Reproducing the measurements

Sketches, superseded by the pre-acceptance benchmark above.

M2–M5 — build a query with *K* variable-bound `object(expression:)` selections, then read the cost:

```bash
gh api graphql -f query="$Q" | jq -c '.data.rateLimit'
```

M6 — REST consumption across a clone (note: **not** the production argv; see the table):

```bash
gh api rate_limit --jq '.resources.core.used' && git clone --depth 1 --single-branch --no-tags <url> /tmp/c -q && gh api rate_limit --jq '.resources.core.used'
```

M7 — count fetch subprocesses during sparse materialization:

```bash
git clone --depth 1 --single-branch --filter=blob:none --no-checkout <url> pc && cd pc && git sparse-checkout init --cone && git sparse-checkout set <dir> && GIT_TRACE=1 git checkout 2>&1 | grep 'run_command.*fetch'
```

M8 — fetch a second branch into an existing shallow clone. The **explicit destination refspec** is
required; without it `--single-branch` leaves the fetch updating only `FETCH_HEAD`:

```bash
git fetch --depth 1 --no-tags origin <branch>:refs/remotes/origin/<branch>
```

M9 — the symlink divergence, fully specified. Tree entry:

```bash
gh api "repos/nodejs/node/git/trees/b2a024b1ad3373d405ca55af23f59dd4cd696c2f?recursive=1" --jq '.tree[]|select(.path=="deps/v8/third_party/ittapi/ittapi-rs/CMakeLists.txt")'
```

REST body with production's Accept header — 2,513 bytes:

```bash
gh api "repos/nodejs/node/contents/deps%2Fv8%2Fthird_party%2Fittapi%2Fittapi-rs%2FCMakeLists.txt?ref=b2a024b1ad3373d405ca55af23f59dd4cd696c2f" -H "Accept: application/vnd.github.raw+json" | wc -c
```

GraphQL blob — 17 bytes, whose `git hash-object` is the tree OID `de0cf227139ff67dd6d0493c03533e48d6ea8634`:

```bash
gh api graphql -f query='{ repository(owner:"nodejs", name:"node") { object(expression: "b2a024b1ad3373d405ca55af23f59dd4cd696c2f:deps/v8/third_party/ittapi/ittapi-rs/CMakeLists.txt") { __typename ... on Blob { oid byteSize isBinary isTruncated text } } } }'
```

### Review history

This ADR was revised across five adversarial review rounds with Codex (gpt-5.6-sol), and the
recommendation moved three times under evidence before settling. It began as clone-first; moved to
GraphQL batching when the shared-clone design's unstated cost was exposed; moved to promoting the
*existing* per-unit clone when review showed only the elaborate shared variant had ever been
evaluated; and returned to GraphQL batching when `.gitattributes` checkout transformations were shown
to break byte determinism for clone-based reading.

Two measurements were taken in response to review challenges during those rounds and each
overturned a claim in the then-current draft. M9 disproved an explicit statement that the transport could not change findings.
M3/M4 indicated that GraphQL batch sizing is bound by the 10-second query timeout rather than by
point cost — one failed sample, so whether that boundary is deterministic is exactly what the
benchmark's boundary probe tests. A third challenge corrected an overstatement in the reverse
direction: excluding `git cat-file` is a real cost, not a security impossibility, and the ADR now
says so.

At the close of round five the reviewer's position was that MADR conformance is satisfied and the
recommendation is defensible as a benchmark-gated proposal, conditional on correcting specific factual
claims — chiefly that "canonical committed bytes" overstated a guarantee the design deliberately
qualifies for symlinks, binary blobs, and truncated trees. Those corrections are applied above; the
guarantee is now scoped to hash-validated regular blobs with its exceptions named.

Two disagreements were recorded rather than resolved at the close of round five. The reviewer would
have the option-selecting benchmark run **before** acceptance; that is why this ADR stayed `proposed`
behind a pre-acceptance gate rather than claiming a settled decision. And the reviewer holds that a
canonical-object clone variant deserves its own evaluation; it was initially listed under Follow-on
work rather than dismissed.

**Both disagreements have since been converted into committed, evidence-gated work** (2026-07-28,
a further adversarial review loop over the
[resolution plan](../plans/adr-0001-disagreements-resolution.md), same reviewer). The benchmark is
now specified to execution level with a pre-registered *symmetric* decision rule — an early draft's
2.0× incumbent-displacement margin was withdrawn under review as exactly the thumb on the scale the
resolution must not contain — and the canonical-object clone variant is evaluated in this ADR as
Option 2c and benchmarked as a first-class driver. Along the way the review overturned two of this
ADR's own framings: the batching seam refactor is Option 1's distinct cost, not a shared one (2c's
interactive child serves the existing one-path seam), and a faithful Option 2a already needs the
`ls-tree` mode source once its symlink policy is taken seriously. Closure is evidence-based, not
declarative: the clone-variant disagreement discharges when Option 2c's benchmark row has actually
run, and the benchmark disagreement discharges when the evidence-based decision is recorded — until
then this ADR remained `proposed`, which was the reviewer's position honoured.

**Both disagreements are discharged** (2026-08-03). D2 discharged at Step C: Option 2c ran as
driver T2c across the full matrix and the fidelity battery. D1 discharged at Step D: the
benchmark executed under its ratified freeze (Steps B–C; PRs #29 and #32), and the evidence-based
decision — the §4.7 sole-eligible output, ratified by the decision-maker — is recorded in the §8
record's Step-D entry, with this document's state change riding the same reviewed PR. The
provisional Option-1 recommendation this document carried from round five onward is superseded by
that output: the recommendation's fourth move under evidence, and the first made by the
pre-registered rule rather than by argument. The reviewer's measure-first position is honoured in
the strongest form available — the ADR changed state only after the measurement.

### Follow-on work

**The implementation.** This decision chooses a direction; it implements nothing. The
implementation PR carries the §3.1/§3.2 bill under this repository's own gates (the Confirmation
checks above), including the production `readOnlyGuard` changes the benchmark deliberately did
not make — its proposed grammars and framed-reader prototype live beside the bench until adopted.

**The tree-request term** is closed by the chosen option: local `ls-tree` enumeration replaces
the per-unit recursive REST tree request, so the separate budgeting ADR that an Option-1
confirmation would have required is moot. Scope stays honest: this removes the per-unit tree
request, not discovery (repo/branch listing), which is unchanged and was excluded from scoring
throughout.

**Option 3**'s measurement vehicle ran at Step C (`option3.json`; report §5): the offline
duplicate-OID analysis over the corpus trees, plus the frozen warm pair on the recommended
driver — 255/255 cache hits with the wall unmoved (1260 → 1274 ms), because the clone dominates.
OID-keyed content caching therefore composes with API read paths, not the chosen one; cross-run
object reuse would be a persisted shared store — a different architecture with its own ADR if
ever wanted. Its symlink exclusion remains a hard requirement.

**Option 2a**'s remaining path closed at Step C: its canonical-read escape hatch *is* Option 2c
(now chosen), and its own checkout reads were measured G1-divergent under the config probe — the
"documented semantic change" an adopter would have had to accept is now an exhibited hazard.

**Revisit this decision if:** implementation shows the §3.2 ledger mispriced — the stdin
containment, child lifecycle, or framed seam proving unworkable under this repository's guard
and test discipline; GitHub materially changes git-transport terms for clone traffic (enforced
pacing, or pack-fetch throttling at scale); the estate's operational profile makes per-unit
clone disk or whole-branch transfer untenable; or GitHub ships a first-class bulk content
endpoint on REST, which would reopen an API path without the per-file request shape.

**Out of scope, deliberately:** the code-search API as a content source (**10** authenticated
requests/minute for Search Code, and index freshness is not commit-pinned), and any approach reading
content from a running service rather than a pinned commit.
