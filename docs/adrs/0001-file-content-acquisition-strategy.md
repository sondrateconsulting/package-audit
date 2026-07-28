---
status: "proposed"
date: 2026-07-28
decision-makers: rvo (repository owner)
consulted: Codex (gpt-5.6-sol) — successive adversarial review rounds; see Review history
informed: operators running `bun run audit` against large estates
---

# Lift the per-file REST rate-limit ceiling by batching file-content reads over GraphQL

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
so no speed ratio between them is quoted. Option 3 was not measured. M7's `pack_header=2,227` means
pack format **version 2 containing 227 objects** — not 227 blobs — so only the single-subprocess
observation is claimed, and it does not generalise to arbitrary access patterns. M8's unchanged
`in-pack` count does not prove full object reuse: loose objects are counted separately and small
fetches may arrive unpacked. M6 was not run with the production argv or environment.

M2/M3 are **client wall time**, not server processing time; against the documented 10-second threshold
they show roughly **1.9 s and 0.8 s of client-observed headroom**. M4 is **one failed request** —
consistent with a timeout, but one sample cannot establish that a size-induced 502 is deterministic.

**M5 vs M3 shows byte count alone is not a sufficient sizing predictor.** M5 moved 3.0 MB across 125 aliases
in 4.7 s; M3 moved 941 KB across 400 aliases in 9.2 s.

**M9, in full, because it decides the transport question.** Path
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

Chosen option: **"Option 1 — Batched blob reads over the GraphQL API, retaining the existing
per-branch clone for truncated trees"**, because it reduces the cold-run request count while giving
the tool **verifiable, per-entry control over byte semantics**, and because its substantial new
surface is entirely in-process, whereas the clone options' surface reaches into the filesystem,
concurrent processes, and platform-dependent behaviour.

The deciding evidence is M9's hash check, and it must be stated with its scope. For a **regular blob
whose `text` is non-null and whose hash validates**, GraphQL demonstrably yields the committed object:
the 17 returned bytes hash to exactly the tree OID. That makes the read *self-verifying* — the tool
can prove which bytes it got. The chosen design then deliberately routes three categories away from
that guarantee, and they are exceptions, not oversights:

* **symlinks** (by validated mode) go to `fetchFileRaw`, which returns REST's *dereferenced*
  non-canonical bytes — chosen to preserve today's findings;
* **binary and indeterminate blobs** go to `fetchFileRaw` too, and that path is itself lossy: spawn
  output is decoded with `Buffer.concat(chunks).toString("utf8")`
  ([github.ts:168](../../scripts/github.ts#L168)), so binary bytes do not survive intact today either;
* **truncated trees** keep the existing clone, with the checkout-transformation caveat below.

By contrast, a checkout gives the tool **no control and no way to detect what it got**. `git checkout`
applies committed `.gitattributes` transformations (`eol`, `ident`, `working-tree-encoding`), changing
both the bytes `cloneReader` reads ([orchestrate.ts:128](../../scripts/orchestrate.ts#L128)) and the
working-tree size `walkClone` records ([orchestrate.ts:140](../../scripts/orchestrate.ts#L140)) — and
therefore whether the 2 MiB gate fires — with the result varying by platform and repository
configuration. Reading canonical objects from a clone instead needs `git cat-file`, which
`readOnlyGuard` currently excludes ([readOnlyGuard.ts:201](../../scripts/readOnlyGuard.ts#L201)). That
exclusion is not an absolute barrier — plain `git cat-file --batch` returns raw object contents, and
`--textconv`/`--filters` are separate opt-in flags the guard's exact-argv grammars could exclude, as
they already do for `show`. It is a real *cost*: new guarded verbs, a validated-OID stdin protocol,
and binary framing that the current UTF-8 spawn decode cannot provide.

That checkout critique decides against **Option 2a specifically** — it does not decide the clone
question. Option 2c below pays the `cat-file` cost deliberately and never checks out, dissolving the
byte-fidelity, symlink, and size-gate objections at once; it is the **strongest challenger** to this
recommendation. What keeps Option 1 recommended over 2c, provisionally, is a surface asymmetry, not a
knockout: Option 1's new machinery is in-process and exercisable through the existing injected-spawn
tests, while 2c's crosses a subprocess protocol boundary — a stdin trust surface the argv guard cannot
see, a long-lived child lifecycle where every subprocess today is one-shot, and disk on the common
path. The pre-acceptance benchmark (Confirmation) compares them under a symmetric pre-registered rule
with no incumbency margin; the surface asymmetry is the decision-maker's ledger, not a numeric
handicap.

**This is not a drop-in transport swap.** Its cost, stated plainly:

1. **A batching seam.** `ReadFile` takes one path and each read is awaited
   ([unitPipeline.ts:46](../../scripts/unitPipeline.ts#L46)), so a reader cannot accumulate requests.
   The seam becomes `prefetch(paths)`/`readFiles(paths)`, or `scanUnit` splits into planning and
   consumption phases — unavoidable, because source relevance is decided inside `scanUnit`
   ([unitPipeline.ts:190](../../scripts/unitPipeline.ts#L190)). This cost is **Option 1's own**, not
   generic to alternatives: Option 2c's reads are local and on-demand, and leave the one-path seam
   intact.
2. **Tree mode preserved *and validated*.** The parser keeps only the object type and drops mode
   ([github.ts:746](../../scripts/github.ts#L746)). Mode must be carried on `TreeEntry` and validated
   against the closed mapping `100644`/`100755`/`120000` → blob, `040000` → tree, `160000` → commit.
   An unvalidated or missing mode fails open straight back into M9.
3. **A batch-specific client method.** The generic `graphql()` retries the identical query
   ([github.ts:1673](../../scripts/github.ts#L1673)), discards status behind `ThrottleExhausted`, and
   and — the real defect — **discards partial `data` on every error-classified path** while dropping
   `errors[].path` ([github.ts:678](../../scripts/github.ts#L678)), so a per-alias handler can never
   see it. (Rate-limit body errors *are* classified and retried rather than treated as fatal,
   [github.ts:595](../../scripts/github.ts#L595); the problem is the lost partial data, not blanket
   fatality.) GitHub documents partial results under resource exhaustion.
4. **An API-wide admission scheduler.** The CPU limit is 90 s per 60 s **shared** across REST and
   GraphQL with a 60 s GraphQL sub-cap, while the client today has only a count semaphore and reactive
   per-bucket pausing ([github.ts:1049](../../scripts/github.ts#L1049)). A GraphQL-only scheduler
   cannot enforce a shared limit while tree reads and fallbacks remain on REST.
5. **Admission caps and failure policy.** Independent caps on alias count, query-document bytes,
   content bytes (M5 vs M3), and total serialized argv size — the client passes query and variables as
   separate `-f` argv elements ([github.ts:1658](../../scripts/github.ts#L1658)) and the real spawn does
   not use stdin ([github.ts:174](../../scripts/github.ts#L174)), so a batch can satisfy a byte cap and
   still fail with `E2BIG`. Splitting must not be the first response to a 5xx — that turns an upstream
   outage into an expanding tree of failures. Order: bounded transient retry, then split only on
   structured timeout/resource evidence or repeated size-correlated failure, with a descendant cap, a
   circuit breaker, and a batch deadline well inside the 15-minute subprocess deadline
   ([github.ts:1007](../../scripts/github.ts#L1007)).
6. **Per-alias fallback with a budget.** Symlinks (routed by validated mode), binary or indeterminate
   blobs, and `isTruncated` blobs fall back to `fetchFileRaw`. A whole-batch failure must never be read
   as N benign absences. Because unrestricted fallback regresses to `O(files)` REST, a per-unit
   fallback budget with defined terminal behaviour is required.
7. **Query construction and response integrity.** GraphQL **variables, never string interpolation** —
   `isCanonicalTreePath` rejects only empty, NUL, `.` and `..` segments
   ([github.ts:774](../../scripts/github.ts#L774)), so a legal path may contain quotes, backslashes or
   newlines. Validate `__typename === "Blob"`, `oid` against `TreeEntry.sha`, `byteSize` against
   `TreeEntry.size`, coherent `isBinary`/`isTruncated`/`text`, and exact alias coverage.
8. **Cache provenance.** `gh3` rows are tied to exact REST-200 bodies
   ([github.ts:1358](../../scripts/github.ts#L1358)) and the accessors call the table REST-only
   ([db.ts:2361](../../scripts/db.ts#L2361)). Reusing them for GraphQL text requires
   `Buffer.byteLength(text) === byteSize`, a local `blob <len>\0<body>` hash check against the tree
   OID, and a cache-namespace bump. With that, existing rows are probed before aliases are built and
   validated results persisted via [db.ts:2403](../../scripts/db.ts#L2403).

Rounds: **round 1** batches manifests and CLI-classifiable paths (knowable from the tree alone);
**round 2** batches the source files round 1's manifests made relevant plus the required nearest
lockfiles. Either round can legitimately be empty.

The clone/API split stays where the code already puts it: complete tree → batched reads; truncated
tree → the existing per-branch `cloneShallow`, with its checkout-byte caveat documented rather than
pretended away.

### Consequences

* Good, because the cold-run content ceiling rises substantially — M2/M3 resolved 250 and 400 blobs
  per request for one point each, against one request per file today.
* Good, because the bytes are **the committed object's bytes**, verified by M9's hash check — the
  property no checkout-based option can offer without reopening `cat-file`.
* Good, because it needs **no new `readOnlyGuard` verb**, no working tree, no interprocess
  coordination, and no platform-dependent filesystem semantics on the batch path. (The SQLite cache
  still uses disk; what the batch path avoids is materialising repository contents.)
* Good, because every piece of new surface is in-process and exercisable through the existing
  injected-`spawn` seam.
* Bad, because the ceiling reduction is **expected-case, not structural**: an unfavourable selected
  set (many symlinks, binaries, or truncated blobs) falls back per file and regresses toward
  `O(files)` REST. Hence the fallback budget.
* Bad, because **the retained per-unit tree fetch stays on REST**. The precise term is distinct
  *uncached* `(host, org, repo, treeOid)` values — tree responses are immutable-cached
  ([github.ts:1943](../../scripts/github.ts#L1943)), so branches sharing a tree share a row — but on a
  cold estate it approaches one request per branch unit, and roughly 5,000 of those per hour still
  exhausts core. This ADR reduces the content term and leaves the tree term standing.
* Bad, because a **per-query point floor** applies: every non-empty query costs ≥1 point. For a
  5,000-point credential and cold units dispatching one non-empty batch per round, that is roughly
  2,500 branch units/hour before splits, retries, and discovery. Empty rounds and cache hits raise it;
  splitting lowers it.
* Bad, because **admission and partial-failure handling are the hard parts**, and this ADR specifies
  them only to the level of requirements, not algorithms.
* Bad, because the point formula is **explicitly subject to change**, so the implementation must read
  `rateLimit { cost }` rather than assume.
* Neutral, because the truncated-tree clone is retained, so the chosen option still uses disk on that
  path and still carries the checkout-byte and temp-sweep hazards described under Option 2a — for the
  same rare repositories as today, not for the whole estate.

### Confirmation

**Pre-acceptance gate (decision evidence, not implementation verification).** This ADR stays
`proposed` until the benchmark specified to execution level in the
[resolution plan](../plans/adr-0001-disagreements-resolution.md) has run and its Step-D decision is
recorded. The gate, summarised — the plan is normative: a checked-in harness over a six-slot pinned
public corpus (multi-branch tree sharing, mid-size, path-heavy, truncated-tree, checkout-affecting
`.gitattributes`, and a symlink/non-UTF-8 fidelity battery) drives pinned selected-path workloads
through four drivers — status quo, Option 1, Option 2a, and **Option 2c** — under preregistered
constants, ordering, and worst-case budget reservation. Option 3 is evaluated compositionally
(offline duplicate-OID analysis plus a warm-run scenario), not as a competing transport. Global
eligibility gates cover route-scoped byte determinism (with a checkout-config probe), completeness,
stability, and resource envelope; eligible drivers are compared per scenario on
budget-normalised serial throughput inside a **calibrated noise band** (`max(1.25, pilot spread)`),
and a driver is recommended only if it dominates — at least one scenario win and no losses against
every other eligible driver. **The rule is symmetric: no incumbency margin protects Option 1**;
design-surface judgment stays with the decision-maker, and every Step-D outcome — confirmation,
challenger win, no-dominator judgment, or remain-proposed-with-remediation — passes one further
adversarial review round before this ADR changes state. An override of the rule's recommendation
requires written rationale recorded in the Review history; an ineligible driver can never be
chosen. Every number in the table above is single-sample and is superseded by the benchmark.

Post-implementation checks:

1. **Separated counters.** Logical selected identities, usable cache hits, cold misses, concurrent
   duplicate misses, repeated non-cacheable responses, batched requests, per-alias REST fallbacks,
   retries, and total HTTP attempts as *distinct* metrics.
2. **Byte-level reader parity.** Compare readers on **raw reader output**, not `UnitResult` — different
   bytes can coincidentally yield identical findings. Cases: the M9 symlink (mode-routed to REST, must
   equal 2,513 bytes), a binary blob, an `isTruncated` blob, a path containing a quote/backslash/newline,
   a path the tree lists but `contents` 404s, and a tree entry with missing or unknown mode (must be
   fatal, not treated as a regular blob).
3. **Request-budget assertion**, stated content-only so the two sides are comparable. GraphQL
   *content* requests equal dispatched post-cache batches plus split descendants plus retries — not
   `ceil(bytes / budget)`. REST *content* attempts equal cache-missing per-alias fallbacks plus
   retries. Tree fetches, repository/owner discovery, and GraphQL branch discovery are counted
   separately and must not be folded into either side.
4. **Admission and failure tests.** A batch exceeding any cap (aliases, query bytes, content bytes,
   argv bytes) splits before dispatch; a simulated 5xx takes the bounded transient retry that
   `classifyGraphql`'s `transient` branch already provides
   ([github.ts:614](../../scripts/github.ts#L614)) and is **not** split on the first failure;
   split descendants are capped; a partial response with `errors[].path` resolves per alias with no
   whole-batch fatal; the fallback budget trips and terminates as defined.
5. **Scheduler test.** Aggregate in-flight response time across REST *and* GraphQL stays under the
   configured shared margin with discovery and content contending at maximum fan-out.
6. **Cache provenance test.** A GraphQL body failing `byteLength`/blob-hash validation is never
   persisted; a guarded-write conflict fails closed; the namespace bump prevents old rows being read
   under new semantics.

## Pros and Cons of the Options

### Option 1 — Batched blob reads over the GraphQL API, retaining the existing per-branch clone for truncated trees

One request resolves many blobs, each a variable-bound `object(expression: "<sha>:<path>")` selection
returning `... on Blob { oid byteSize isBinary isTruncated text }` plus `__typename`.

* Good, because the request reduction is measured (M2, M3) at one point per batch.
* Good, because it returns **canonical committed bytes** (M9 hash check).
* Good, because it reads only selected files — no whole-tree transfer, no working tree, no disk on the
  batch path.
* Good, because it requires no new `readOnlyGuard` verb.
* Neutral, because the two-round shape is forced by the pipeline's dependency order, not by batching.
* Bad, because its worst case is also `O(files)` REST via per-alias fallback.
* Bad, because it leaves the per-unit tree request on REST.
* Bad, because it adds a point floor the status quo does not have.
* Bad, because seam refactor, mode validation, batch client method, API-wide scheduler, admission caps,
  and cache provenance are all genuinely new work.

### Option 2a — Promote the existing per-unit shallow clone to the default content path

Flip the routing at [orchestrate.ts:823](../../scripts/orchestrate.ts#L823) so every unit clones, add a
size-based escape to `apiReader`, and enumerate locally with `walkClone` instead of fetching the tree.

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
* Bad, because 2a's operational inheritance stands: disk on every unit (pack-only — smaller than
  2a, but the common path now touches disk where Option 1's does not), the unowned `pkg-audit-*`
  sweep hazard ([github.ts:2096](../../scripts/github.ts#L2096)), single-attempt clone, whole-branch
  transfer however few files are selected, and 15 ops/s/repo pacing with no headroom header.

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
  the full per-file price. Its value depends on the estate's duplicate-OID ratio, which is unmeasured.
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

Two measurements were taken in response to review challenges and each overturned a claim in the
then-current draft. M9 disproved an explicit statement that the transport could not change findings.
M3/M4 established that GraphQL batch sizing is bound by the 10-second query timeout rather than by
point cost. A third challenge corrected an overstatement in the reverse direction: excluding
`git cat-file` is a real cost, not a security impossibility, and the ADR now says so.

At the close of round five the reviewer's position was that MADR conformance is satisfied and the
recommendation is defensible as a benchmark-gated proposal, conditional on correcting specific factual
claims — chiefly that "canonical committed bytes" overstated a guarantee the design deliberately
qualifies for symlinks, binary blobs, and truncated trees. Those corrections are applied above; the
guarantee is now scoped to hash-validated regular blobs with its exceptions named.

Two disagreements were recorded rather than resolved at the close of round five. The reviewer would
have the option-selecting benchmark run **before** acceptance; that is why this ADR stays `proposed`
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
then this ADR remains `proposed`, which is the reviewer's position honoured.

### Follow-on work

**The tree-request term.** Option 1 leaves one REST tree request per distinct uncached tree.
**Option 2c eliminates this term entirely** (local `ls-tree` enumeration); it needs its own ADR only
if Option 1 is confirmed, in which case closing it means either local enumeration (a clone, with the
consequences above) or a budgeting strategy for listing pages.

**Option 3** should be scheduled on evidence: measure the estate's duplicate-OID ratio from trees
already fetched — a cheap offline analysis — before committing. The benchmark plan carries the
concrete vehicle: that offline analysis over the corpus trees plus a warm-run scenario on the
recommended driver(s), which also has to state honestly what git's native object reuse already
provides on clone paths. Its symlink exclusion is a hard requirement.

**Option 2a** is not dead, but its canonical-read escape hatch is no longer follow-on work — that
path *is* Option 2c, evaluated above and benchmarked as a first-class driver. What remains open for
2a specifically: if the benchmark shows Option 1's fallback rate or scheduler overhead dominating
*and* 2c's child lifecycle proves unacceptable, 2a becomes viable only by accepting
environment-dependent findings as a documented semantic change.

**Revisit this decision if:** the pre-acceptance benchmark fails its declared margin; GitHub's GraphQL
point formula, per-query timeout, or partial-result behaviour changes materially; or GitHub ships a
first-class bulk content endpoint on REST.

**Out of scope, deliberately:** the code-search API as a content source (**10** authenticated
requests/minute for Search Code, and index freshness is not commit-pinned), and any approach reading
content from a running service rather than a pinned commit.
