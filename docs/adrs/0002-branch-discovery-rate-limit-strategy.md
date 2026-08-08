---
status: "accepted"
date: 2026-08-05
decision-makers: rvo (repository owner)
consulted: Codex (gpt-5.6-sol) — adversarial ADR review rounds; see Review history
informed: operators running `bun run audit` against multi-organization estates
---

# Lift the per-repository GraphQL point floor in branch discovery by alias-batching refs page-1 queries across repositories

## Context and Problem Statement

*This section states the behavior as it stands — the problem the decision addresses. What replaces
it is the Decision Outcome below.*

Branch discovery is the run path's **sole GraphQL consumer**. For every kept repository,
`listBranchHeads` issues at least one GraphQL query
([github.ts:2322](../../scripts/github.ts#L2322)) fetching `defaultBranchRef{name}` plus one
`refs(refPrefix:"refs/heads/", first:100, after:$endCursor)` page with
`target{...on Commit{oid committedDate tree{oid}}}`, and paginates until `hasNextPage` is false —
§5.B mandates enumerating **all** pages because `RefOrderField` cannot order heads by commit date
server-side ([PROMPT.md:831-833](../../PROMPT.md#L831)). The response is validated fail-closed —
completeness, per-page default re-assertion, heads↔default pairing; the operative validation loop
is [github.ts:2344-2473](../../scripts/github.ts#L2344) — and becomes the `BranchSnapshot` every
downstream decision consumes ([github.ts:1122-1133](../../scripts/github.ts#L1122)).

Three properties fix the cost shape:

* **GraphQL is never cached, deliberately.** The §3 skip predicate compares the *live* head OID
  against the stored one, so discovery must observe the live refs on every run
  ([github.ts:2195](../../scripts/github.ts#L2195), [PROMPT.md:645](../../PROMPT.md#L645),
  [PROMPT.md:874-875](../../PROMPT.md#L874)). A rescan of a completely unchanged estate therefore
  re-spends the full discovery cost; what it saves is the *scan* work, not the *discovery* work.
* **Every non-empty GraphQL query costs at least 1 point**
  ([ADR-0001, More Information](0001-file-content-acquisition-strategy.md#more-information)).
  One repository per query puts a hard floor of one point per kept repository per run under the
  entire tool.
* **`--plan` spends the same nominal successful-path cost**: it calls the same `listBranchHeads`
  per kept repository ([orchestrate.ts:1173](../../scripts/orchestrate.ts#L1173)), so previewing
  a large estate prices like scanning it, discovery-wise. (Parity is nominal only: plan walks
  owners sequentially while the scan fans owners out, so retry, throttle, and window-reset
  behavior can differ between the two.)

Repositories are processed sequentially within an owner, behind a per-repository abort check
([orchestrate.ts:463-469](../../scripts/orchestrate.ts#L463)), while owners fan out bounded by
`concurrency.organizations` ([orchestrate.ts:328](../../scripts/orchestrate.ts#L328)), and each
repository's snapshot is fetched immediately before that repository is planned and scanned
([orchestrate.ts:552](../../scripts/orchestrate.ts#L552)) — discovery spend is interleaved with
scan work, not front-loaded.

### The cost model, stated precisely

**Nominal successful-path floors, with no fallback paths taken** — excluding retries (up to
`MAX_ATTEMPTS = 6` per call, [github.ts:1209](../../scripts/github.ts#L1209)),
failed-then-requeued discoveries, and any timeout penalties — **scoped to github.com's documented
limits under the expected deployment credential: an interactive operator's `gh` user token**
(`gh` can also carry forwarded App/installation tokens, which follow their own tiers — ADR-0001's
note). The tool supports arbitrary GitHub hosts, where limits are site-configurable (GHES may
disable or retune them); response headers are authoritative there and everywhere. Let *R(o)* be
owner *o*'s kept repositories after the §5.A denylist, archived/fork filter, and
`maxReposPerOrg` cap; *R* = Σ *R(o)*; *heads(r)* repository *r*'s branch count. Per run (scan
**or** `--plan`), with today's one-repository-per-query discovery:

```
page-1 queries        =  R
continuation queries  =  Σ over r of max(ceil(max(heads(r), 1) / 100) − 1, 0)
GraphQL points        ≥  the sum of both (each query prices at the 1-point minimum)
```

Against the primary budget of **5,000 points/hour** for ordinary user/PAT authentication —
higher tiers require qualifying App/OAuth or installation credentials (see
[Limits](#limits-this-decision-is-measured-against)) — the *R* term alone binds at roughly
**5,000 kept repositories per hour**. The complaint this ADR addresses is exactly that shape:
rescans against multiple organizations and/or organizations with large repository counts. An
estate of 8 organizations × 750 kept repositories carries a ≥ 6,000-point nominal discovery
floor — more than one full window — interleaved with its scan work. Whether the wall is hit
mid-run depends on the spend *rate*: a cold scan's clone-and-scan time can carry the run across a
reset, but a **rescan is precisely the fast case** — units mostly settle skip-as-current
([orchestrate.ts:651](../../scripts/orchestrate.ts#L651)), discovery dominates the spend rate,
and the run hits the wall with the estate part-discovered **even though nothing changed**.

Hitting the wall is handled, not avoided: primary exhaustion arrives as an HTTP-200 body error —
`errors[].type` `RATE_LIMITED`, or `RATE_LIMIT`, the field-observed (not documented-contract)
spelling seen once the window is already exceeded ([PROMPT.md:754-756](../../PROMPT.md#L754)) —
and classifies per §4 keyed on the response headers: primary when `x-ratelimit-remaining` is
`0`, secondary otherwise ([github.ts:803-806](../../scripts/github.ts#L803)). A primary throttle
pauses the graphql bucket until the reset epoch inside the 8-hour total pause budget
([github.ts:713](../../scripts/github.ts#L713)) and the call retries in place; only retry
exhaustion or an unfundable pause defers the repository via `requeue-throttle`. The spec itself
records the posture: *"pausing is REACTIVE only … nothing watches `remaining` to pause BEFORE a
limit is hit"* ([PROMPT.md:768-771](../../PROMPT.md#L768)). As ADR-0001 put it about the same
wall on the REST side: that **paces and defers the cost; it does not reduce it**.

ADR-0001 removed the dominant REST content spend — regular blobs ride per-unit no-checkout
clones; the ratified symlink policy keeps a REST dereference lane for mode-`120000` entries
([orchestrate.ts:105](../../scripts/orchestrate.ts#L105)). Branch discovery's
one-point-per-repository floor is now the tool's **binding per-repository API cost** — for
comparison, with *L(o)* the *raw* listed repository count (filters and the cap run client-side
*after* listing), the repository-list calls cost `Σ over o of max(1, ceil(L(o)/100))` REST
requests — 100 for a 25-owner estate listing 400 each with no filtered extras (owner discovery
via `user/orgs` adds its own pages when organizations are auto-discovered) — while discovering
the same estate's branches costs ≥ 10,000 GraphQL points.

**Question:** how should `package-audit` discover branch heads so that a multi-organization
estate — and especially its *rescans* — stays comfortably inside the GraphQL primary budget,
without weakening §5.B's snapshot guarantees?

**Scope.** The target is the branch-discovery seam — `listBranchHeads`
([github.ts:2322](../../scripts/github.ts#L2322)) and its two consumers,
`discoverBranchHeads` ([orchestrate.ts:521](../../scripts/orchestrate.ts#L521)) and `runPlan`
([orchestrate.ts:1173](../../scripts/orchestrate.ts#L1173)). Repo listing (§5.A REST), content
acquisition (ADR-0001), the §4 throttle buckets and taxonomy, and the report/export layers are
unchanged throughout, except where an option states otherwise.

### Evidence already in the repository

The ADR-0001 measurement series and its Step-C boundary probe bear on alias batching:

* M2/M3/M5: aliased GraphQL batches of 250 / 400 / 125 blob selections each cost **1 point**
  ([ADR-0001, Measured baseline](0001-file-content-acquisition-strategy.md#measured-baseline)).
* M4: one 462-alias attempt returned HTTP 502 — a single failed sample.
* The Step-C boundary probe then could **not** reproduce M4: alias counts {250 … 475} at small
  content and {150, 250} × {1.5 MiB, 3 MiB} all returned 200/ok, 3 tries per cell — statuses and
  sizes in the [report table](0001-benchmark/report.md#boundary-probe-44), per-try
  `pointsCost: 1` in [boundary-probe.json](0001-benchmark/boundary-probe.json). The 502 boundary
  is therefore not a deterministic alias-count cliff in the probed range.

One asymmetry keeps these results from transferring directly: blob `object(…)` selections are not
connections, so those queries ride the 1-point minimum. `refs(first:100)` **is** a connection —
per GitHub's published formula (retrieved 2026-08-04): *"Add up the number of requests needed to
fulfill each unique connection in the call. Assume every request will reach the `first` or `last`
argument limits. Divide the number by 100 and round the result to the nearest whole number to get
the final aggregate point value."* Minimum 1 point. A batch of *B* aliased repositories each
selecting one `refs(first:100)` page would price at ≈ `max(1, round(B/100))` points **if the
formula holds for this shape** — the formula is declared subject to change, the probes above
measured a different query shape, and server-side weight per refs alias (ref iteration plus
commit lookups) exceeds a blob alias's. None of the probed evidence prices *this* query; that is
exactly what the Confirmation probe below exists to measure, with a pre-registered acceptance
rule rather than an assumption.

## Decision Drivers

* **Reduce the per-run GraphQL point count structurally.** Pacing and deferral do not count
  (ADR-0001's driver, unchanged).
* **Preserve §5.B's snapshot guarantees.** Live heads observed every run (the §3 skip
  predicate's requirement), heads and default branch resolved from the same snapshot, fail-closed
  completeness validation. **No new staleness class**: snapshot reuse across runs — deciding from
  refs *not observed this run* — is disqualifying. Widening the *existing, disclosed*
  discovery-to-scan window is acceptable only if bounded (in repositories *and* in time), stated,
  and configurable down to today's behavior.
* **Preserve the §4 throttle taxonomy and per-repository fail-soft granularity.** One
  repository's discovery failure must stay one repository's failure
  ([orchestrate.ts:521-540](../../scripts/orchestrate.ts#L521)).
* **Respect every applicable limit — a goal, not a guarantee** (ADR-0001's caveat, refined:
  GitHub publishes the shared ≤100-concurrent-request cap and shared CPU bounds, and reserves
  *further* undisclosed checks on top). Within that: stay well under the 10-second query budget,
  because timed-out requests are penalized with *additional* primary-point deductions (retrieved
  2026-08-04) — an oversized batch is worse than a small one, not merely slower.
* **Proportionate, containable change.** Prefer a change confined to the discovery seam over new
  transports, new persistence, or new trust boundaries; prefer failure modes that degrade to
  today's behavior.

## Considered Options

* **Option 1 — Alias-batched GraphQL branch discovery**: one query fetches page 1 of
  `refs` + `defaultBranchRef` for up to *B* repositories of the same owner
* **Option 2 — Change-detection skip**: persist snapshots; reuse them for repositories whose §5.A
  listing evidence (`pushed_at`, `default_branch`) says nothing moved
* **Option 3 — Git-transport discovery**: `git ls-remote --symref` (or a heads-wide filtered
  clone) per repository, retiring GraphQL from steady-state discovery
* **Option 4 — Proactive budget pacing**: watch `remaining`, pause before the wall, prioritize
  spend — no per-run reduction
* **Option 5 — Credential scaling**: GitHub App installation tokens / qualifying credentials to
  multiply the budget
* **Option 6 — Fused listing + discovery**: one owner-scoped nested query
  (`repositoryOwner … repositories(first:100){ … refs(first:100) }`) replaces both the §5.A
  REST listing and page-1 discovery

## Decision Outcome

Chosen option: **"Option 1 — Alias-batched GraphQL branch discovery"**. Four options remove —
or further shrink — the per-repository page-1 point floor while keeping refs observed live on
every run: this one, both Option 3 variants (variant (a) observes refs live over `ls-remote`
and keys its persisted metadata by observed OID — immutable facts, not reused observations),
and Option 6's fused owner-scoped query. Option 1 is chosen because it does so **inside the existing discovery seam
alone**: no new transport surface, no guard-grammar growth, no per-repository clone
negotiation, no rewrite of the §5.A listing lane, and the one enabling mechanism with in-repo
measured evidence (M2–M5, boundary probe). The cost is one honestly-stated widening: the existing discovery-to-scan window grows
from "immediately before this repository" to a window bounded in repositories (≤ *B*), in time
(an explicit snapshot age cap), and in memory (an explicit head budget), with batching disabled
reproducing today's behavior exactly. The reduction is structural on the page-1 term (~*B*× per
owner at full batches; the continuation term for branch-heavy repositories is unchanged), and
there is no database-schema change and no new trust boundary.

The recommendation is definitive. Per this repository's practice the ADR remained `proposed`
until the decision-maker ratified it: **rvo ratified Option 1 on 2026-08-05** at the Stage-P
gate (PR #40), with the batch-size default pinned by the pre-registered Confirmation probe —
**B = 25** — not by this document.

### The design, concretely

* **Batch shape.** One GraphQL query carries up to *B* aliased
  `rN: repository(owner:$oN, name:$nN){ defaultBranchRef{name} refs(refPrefix:"refs/heads/",
  first:100){ pageInfo{hasNextPage endCursor} nodes{…} } }` selections — page 1 for each of *B*
  repositories of one owner. **Owner and repository names bind as separate GraphQL variables per
  alias, never as inline literals**: `isCanonicalIdentity` rejects separators, dot-segments,
  controls, and whitespace but deliberately not GraphQL metacharacters like quotes or braces
  ([github.ts:995-998](../../scripts/github.ts#L995)), so validation does not make interpolation
  safe. 2*B* variables at *B* = 25 is 50 `-f` arguments — bounded and well under argv limits.
  **Each alias also selects the repository's own identity — `nameWithOwner` (or `name` plus
  `owner{login}`) — and the router re-asserts it against that alias's bound variables before
  any snapshot is accepted**: a swapped variable or alias mapping must fail closed as a
  batch-shape anomaly, never attach a structurally valid snapshot to the wrong repository —
  the batched analog of the REST lane's identity re-assertion
  ([github.ts:1039-1059](../../scripts/github.ts#L1039)).
* **Operator surface.** Batch size ships as a validated config key (`discovery.batchSize`,
  integer, `1` to the probe-pinned default; default = that pin). `1` is the normative bypass.
  Values between 1 and the default ride a stated monotonicity assumption — fewer aliases means a
  strictly smaller query and response than a probe-validated larger size, so intermediate sizes
  are safe-side for the transport even where unprobed; values above the default are rejected as
  unsupported. The age cap and head budget ship as constants — the escape hatch the drivers
  promise is `batchSize: 1`, and over-configuring safety bounds is its own failure mode. The key
  must not perturb the §3 skip predicate; its config-hash treatment is decided in the
  implementation bill against how existing operational-only keys are handled, and documented
  there.
* **Full snapshots before the window is served** (with the two planned exceptions below). The
  prefetcher completes each repository's *entire* snapshot at batch time: the batched page-1
  response, then — immediately, in kept order, before any window repository is handed to
  processing — the existing per-repo continuation pagination for repositories whose
  `hasNextPage` is true (same `MAX_PAGES` bound, per-page default re-assertion,
  duplicate/cursor guards). A repository's page-1 → page-N gap is therefore bounded by the
  *window's own pagination work* — wider than today's back-to-back walk when several window
  repositories paginate, but never interleaved with scan work — and the fail-closed completeness
  guards are unchanged and remain the net under that widening. The exceptions: a head-budget
  or continuation-time stop defers not-yet-paginated repositories to the per-repo path, and an
  age-capped or degraded repository re-fetches there too.
* **Everything is staged; per-repository outcomes commit only at consumption.** Every window
  outcome — a completed snapshot, a per-alias failure from the closed family, a
  continuation-phase failure — is held staged and produces **no staged per-repository side
  effect** — no DB row, no per-repository JSONL discovery/unit event, no repository-scoped
  progress event — until the owner loop consumes that repository, after its existing
  per-repository abort check ([orchestrate.ts:463-469](../../scripts/orchestrate.ts#L463)).
  (Transport-level telemetry is call-time and shared by nature — spawn and rate-limit progress
  events, bucket pause state ([github.ts:1552-1565](../../scripts/github.ts#L1552)) — and is
  not, and cannot be, discarded.) At consumption, a staged failure becomes exactly the outcome
  its solo call would have produced: the run's errors row or `requeue-throttle`
  ([orchestrate.ts:521-540](../../scripts/orchestrate.ts#L521)), or `--plan`'s per-repository
  `discoveryErrors` count and log line
  ([orchestrate.ts:1171-1177](../../scripts/orchestrate.ts#L1171)). An abandoned window
  therefore leaves no per-repository trace — and the **age cap applies to every staged item,
  snapshot or failure, with one exception**: staleness is bounded uniformly, and an expired
  staged item is discarded and its repository re-fetched per-repo at consumption — except a
  staged *throttle* outcome, which commits its mode's throttle mapping no matter its age —
  `requeue-throttle` in a run; in `--plan`, which has no requeue, that repository's
  `discoveryErrors` count and log line
  ([orchestrate.ts:1171-1177](../../scripts/orchestrate.ts#L1171)) — because §4's deferral
  is to the *next invocation* and has no mid-run re-queue
  ([PROMPT.md:733-741](../../PROMPT.md#L733)): a mid-run solo re-fetch of a throttled
  repository would retry what the contract says waits.
* **A window bounded in repositories, seconds, and memory — with defined mechanics.** The
  window holds at most *B* staged items, released as consumed, fetched per-owner in
  **tumbling windows**: the owner loop consumes in kept order, and reaching a repository
  whose item is not held dispatches the next batch of up to *B* — windows are disjoint,
  never incrementally refilled, so the head budget and the age cap always scope to one whole
  window at a time. A staged snapshot's **age epoch is the monotonic dispatch
  timestamp of the attempt whose validated envelope was retained** — internal retries and §4
  pauses advance it, so a freshly-succeeded response is never born stale; continuation pages
  extend a snapshot without refreshing its epoch. A staged *failure* epochs at its own
  occurrence — covering failures with no dispatch at all, like an unfundable-pause
  `ThrottleExhausted` staged before any request goes out (recorded for the artifact trail;
  staged throttle outcomes themselves are exempt from age re-fetch — the staging rule
  above). The **age cap** (default 10 minutes) is checked at
  consumption, as above. The **head budget** (default 50,000 heads), checked at page boundaries
  during the continuation phase and scoped to the current window — it counts the heads
  resident in the window's staged items at the moment of the check (a failed or discarded
  item's heads leave the count with it): a memory bound, not a cumulative-observation cap.
  The budget is per-window and windows are per-owner, so with owners fanned out the
  run-wide resident envelope is `concurrency.organizations ×` (the budget + one
  repository's `MAX_PAGES`-bounded overshoot — up to `MAX_PAGES × 100` heads,
  [github.ts:689](../../scripts/github.ts#L689)); the budget bounds each window, not the
  process.
  Crossing it *completes the in-flight repository's pagination* (a single snapshot is never truncated; `MAX_PAGES` alone
  bounds one repository, so the budget can overshoot by at most one repository's heads) but
  starts no further continuation and dispatches no further batch for this window — completed
  snapshots are served, deferred repositories fall to the per-repo path on demand, and batching
  resumes with the next window once the stopped one is consumed. A third planned bound is a **stop
  trigger at dispatch boundaries, not a duration guarantee**: the prefetcher dispatches a
  further continuation only if the window's elapsed time plus that call's worst case (the
  spawn deadline plus any published pause horizon) still fits within half the age cap;
  otherwise it stops there under the same mechanics — the in-flight repository completes (a
  single snapshot is never truncated), completed snapshots serve, the rest defer lazily, no
  downshift. One admitted call can still drain past the cap (boundary-only cancellation),
  and its repository then simply expires at consumption — the age cap remains the net; the
  stop exists so a branch-heavy window cannot *systematically* paginate itself expired. All
  fallback re-fetches are
  **lazy** — issued when the owner loop reaches the repository, not eagerly at anomaly time —
  so a fallback fetch cannot itself age in the window. The prefetcher extends the existing
  abort pattern to a **new** boundary: today's loop checks before each repository and
  `listBranchHeads` has no mid-pagination check; the prefetcher checks before dispatching each
  batch *and each continuation call*, an in-flight call drains naturally (boundary-only
  cancellation, the §4 contract), and its staged result is discarded. Cross-owner batching is
  deferred, not adopted (see Option 1's variant notes).
* **What the widened window means, stated honestly.** Within the window, the run decides from a
  snapshot up to *B*-repositories-of-processing (and at most age-cap) old. Four effects already
  exist today across the discovery-to-scan gap (usually seconds; unbounded when branch units
  queue behind long sibling scans within a repository,
  [orchestrate.ts:552](../../scripts/orchestrate.ts#L552)) and simply widen: a unit can
  skip-as-current against a head the branch has since left
  ([orchestrate.ts:651](../../scripts/orchestrate.ts#L651)) — the new commit is picked up next
  run; policy/cutoff/cap classification runs on heads as of prefetch time (the shared planner at
  [orchestrate.ts:569](../../scripts/orchestrate.ts#L569), dispositions recorded at
  [orchestrate.ts:579-606](../../scripts/orchestrate.ts#L579)); a branch created after
  prefetch is absent from this run; and a staged per-alias *failure* commits at consumption
  even when its cause has since cleared — a repository restored after `NOT_FOUND`, access
  granted after `FORBIDDEN`, a transient continuation fault long gone — recording a failure
  the solo path's narrower gap would usually have dodged (re-validating staged failures at
  consumption was rejected: it would re-spend a query per staged failure to buy what the next
  run's live re-discovery already provides, and the age cap bounds the false-failure window
  exactly as it bounds snapshot staleness — staged failures carry age epochs too; the
  age-exempt staged *throttle* outcome commits only a deferral, never a permanent record, so
  everything that can become a permanent record stays age-bounded). Only the
  clone path fails loud on movement (the §5.C pinned-OID check). All four are self-healing at
  the next run's live re-discovery. This is a wider instance of an existing disclosed window —
  not a new staleness class.
* **Batching disabled is a normative bypass, not a one-alias batch.** Batching engages at
  *B* ≥ 2. At *B* = 1 the window machinery is not engaged at all and orchestration parity is
  exact — same call sequence, same events, same abort boundaries as today: the escape hatch
  reproduces today's behavior exactly, not approximately. Degrades *inside* a *B* ≥ 2 window
  reuse the same untouched solo client call (same unaliased query, same retry behavior), but
  the window machinery is by then already engaged — degrade parity is at the call level, not
  the orchestration level.
* **A batch-aware envelope seam: classified, then staged, then partitioned.** Today's
  single-repo path classifies any 2xx body error call-fatally before the caller sees data
  ([github.ts:821-825](../../scripts/github.ts#L821)), and `parseGraphqlEnvelope` does not
  surface `errors[].path` — so batching adds a sibling entry point sharing the same bucket
  lease, under one governing rule: **a batched call can produce a permanent per-repository
  record through exactly one door — the recognized per-alias family — and every other outcome
  resolves without one.** Normatively, in order:
  1. **Call-scope classification first, on every response.** Throttle and SSO evidence is
     classified before any data validation — readable errors are classified before envelope
     shape, today's own order ([github.ts:848-851](../../scripts/github.ts#L848)) — so a
     pathless `RATE_LIMITED`, a field-observed `RATE_LIMIT`, or a secondary signature is
     **never** mistaken for a batch-shape anomaly whatever the HTTP status, and SSO evidence
     likewise on the statuses today's classifier reads it from (403/429,
     [github.ts:792-796](../../scripts/github.ts#L792)).
     Batched dispositions: a primary throttle pauses the bucket and retries the same batch in
     place (the wait-then-retry sequencing solo calls get); a secondary waits and retries.
     **Exhaustion is cause-tagged on the batched path** — today's untagged `ThrottleExhausted`
     cannot distinguish a throttle-exhausted call from a transient-exhausted one
     ([github.ts:2262-2263](../../scripts/github.ts#L2262)), and the two are dispositioned
     differently. **A mixed retry sequence resolves by evidence, not recency: if any attempt
     in the exhausted sequence observed a throttle signal (primary or secondary), the
     exhaustion is throttle-tagged** — §4's posture is defer, and degrading a window whose
     bucket throttled mid-sequence would solo-re-fetch *B* repositories into a bucket the
     contract says waits; only a sequence with no throttle evidence anywhere is
     transient-tagged. The dispositions: *throttle* exhaustion (and an unfundable pause) stages the whole window as
     `requeue-throttle` — the batched analog of today's per-repository requeue, disclosed as
     such — while *transient* exhaustion degrades (step 2). In `--plan`, at consumption, staged
     window transients become per-repository `discoveryErrors` counts, never labeled a
     permanent failure.
  2. **Documented-timeout shapes degrade; other 5xx retry.** A batched 502/504 — the
     documented timeout statuses, penalty-bearing — degrades-and-downshifts *before* the
     generic transient arm can same-size-retry it. Other 5xx keep today's transient
     backoff-retry at the same size, bounded by `MAX_ATTEMPTS`; exhaustion
     degrades-and-downshifts. So does the truncation shape: a 200 with an unparseable body
     and nonzero exit keeps its bounded transient retry
     ([github.ts:2249-2252](../../scripts/github.ts#L2249)), degrading-and-downshifting only
     on exhaustion. A **no-response** (which, in this harness, includes a client deadline kill —
     the spawn deadline yields empty output that parses as status 0,
     [github.ts:2217](../../scripts/github.ts#L2217), so the two are indistinguishable and
     share one disposition) degrades-and-downshifts: it may *be* a size-induced timeout, and
     the per-repo path re-applies today's exact no-response semantics truthfully. **Every
     other non-throttle throw from the batched pipeline shares that disposition** — thrown
     before response classification (the output cap, stream errors, spawn failure) or from
     the classification, envelope-validation, staging, or partition machinery itself (the
     existing validation battery throws invariants throughout,
     [github.ts:2344-2473](../../scripts/github.ts#L2344)) — expected transport failures
     and unexpected invariant or programmer errors alike are caught at the window boundary
     and degrade-and-downshift. Two routes take precedence over this arm and are
     not part of it: `ThrottleExhausted` — including the pre-dispatch unfundable-pause
     throw ([github.ts:1918-1927](../../scripts/github.ts#L1918)) — always rides the
     cause-tagged throttle door of step 1, and continuation-phase throws are
     repository-local under the containment rule above, never window-wide. The uniform arm
     routes on nothing, because nothing reliable exists to route on: these throws are a mix
     of untagged `GithubApiError`s ([github.ts:176](../../scripts/github.ts#L176),
     [github.ts:332-345](../../scripts/github.ts#L332),
     [github.ts:418](../../scripts/github.ts#L418)) and arbitrary rethrown values — a
     reader failure propagates the original thrown value unchanged
     ([github.ts:443-451](../../scripts/github.ts#L443)), and `Bun.spawn`'s own failures
     arrive unwrapped ([github.ts:257-279](../../scripts/github.ts#L257)) — and none is
     retried by the attempt loop (they propagate past it). Nor would letting them escape be
     "as today": today's seam blanket-catches every solo throw into that one repository's
     fail-soft outcome — throttle exhaustion requeues, everything else records that
     repository's errors row
     ([orchestrate.ts:521-538](../../scripts/orchestrate.ts#L521)) — and a *B*-wide escape
     would stamp one failure across the window through no door. The degrade's lazy solo
     re-fetches instead reproduce each repository's true outcome — a systematic fault
     re-throws into today's per-repository catch — and within a run a persistent fault
     converges through the downshift ladder to *B* = 1, today's path exactly. (Downshift
     state is per-owner and per-run: an owner whose repositories run out before the ladder
     bottoms re-enters the next run at the configured default — the ladder bounds each
     run's waste; it does not remember across runs.)
  3. **Every remaining call-scope outcome that classifies fatal today** — permission-shaped
     403s, residual statuses, redirects, unexpected 2xx shapes — **degrades**: the one-door
     rule forbids stamping *B* permanent records from one response, and each solo re-fetch
     reproduces the fatal truthfully for its own repository.
  4. **Envelope staging.** Surviving responses are validated in full before any per-alias
     outcome is accepted; if any batch-shape anomaly (step 5) exists anywhere in the envelope,
     the whole envelope is discarded and the window degrades — no per-alias outcome, success or
     failure, is taken from an envelope that also carries an anomaly, so a false permanent
     error can never coexist with its own successful solo retry.
  5. **Per-alias routing for a closed family; all else degrades.** A body error stages a
     one-repository failure only if its `path` roots at an alias **and** its type is exactly
     `NOT_FOUND` or `FORBIDDEN` — the shapes a solo call fails one repository on; an alias
     carrying multiple errors qualifies only if *every* one is in the family. Extending the
     family requires authoritative or field-observed evidence that the type is
     repository-scoped, decision-maker sign-off, and fixtures — not fixtures alone. Everything
     else is a batch-shape anomaly and degrades, never guesses: a pathless error, an
     unrecognized type — explicitly including GitHub's documented resource-limit family (node
     limit, resource exhaustion, timeout wording), which can arrive alias-rooted beside partial
     data — an alias with no data and no matching error, or a malformed envelope. The per-repo
     re-fetch's *existing* classification decides fatality; misrouting cost is bounded at one
     extra per-repo pass.
* **Degrade and downshift, with defined triggers.** Every anomaly that degrades also
  downshifts — the trigger list is exhaustive: envelope anomalies, batched 502/504,
  no-response, 5xx retry exhaustion, truncation-shape retry exhaustion, the step-3
  call-scope fatals (SSO and permission shapes, redirects, unexpected 2xx shapes, residual
  statuses), and every non-throttle throw from the batched pipeline (output cap, stream
  errors, spawn failure, unexpected errors — `ThrottleExhausted` rides the throttle door,
  and continuation-phase throws are repository-local, so neither triggers a downshift). The
  output cap and an oversized-argv spawn failure are direct batch-size evidence; the rest
  downshift conservatively — a wrongly-halved batch is the cheap error, repeating a shape
  the transport just rejected is not. Age-cap expiry, head-budget stops, and the
  continuation-time stop are *planned bounds*, not anomalies: they fall back per-repo
  without downshifting. On a trigger, the window's unconsumed repositories re-fetch
  lazily through the existing per-repo path and the owner's batch size halves — `floor(B/2)`,
  floor 1 (25 → 12 → 6 → 3 → 1), per-owner state, reset at run start, no cross-run memory. A
  degraded window's re-spend is the failed batch plus each re-fetched repository's *full*
  per-repo pagination — up to `Σ pages(r)` over the window as a **nominal no-retry bound**
  (each logical page may spend up to `MAX_ATTEMPTS` physical attempts, and any timeout penalty
  is additive and unquantified). A degraded batch envelope covers page 1 only, so degradation
  duplicates page-1 work; *completed continuation pages* are duplicated by the age-cap path
  instead — a re-fetch after a window's continuations had already run (absurd worst case
  *B* × `MAX_PAGES`). A head-budget or continuation-time stop duplicates page-1 work alone: each
  deferred repository's batched page 1 was already paid for, and its lazy per-repo re-fetch
  pays it again — at most *B* − 1 duplicated page-1 points per stopped window (the in-flight
  repository completes rather than deferring), on top of the baseline continuations those
  repositories owed anyway; like every fallback bound here, that is nominal no-retry logical
  spend (each lazy solo query may spend up to `MAX_ATTEMPTS` physical attempts, and any
  timeout penalty is additive and unquantified). Bounded, rare, and preferable to repeating a shape the endpoint
  just rejected with a penalty attached.
* **Batch size.** Probe candidate **B = 25** (worst case 2,500 requested ref nodes plus 25
  repository nodes — two orders of magnitude under the 500,000-node limit; expected response
  bytes well under the multi-MiB bodies the blob probes exercised — a 2,500-ref page-1
  envelope is low hundreds of KB by field arithmetic, though unmeasured for this shape —
  and refs-shape server weight is unprobed; both are exactly the Confirmation probe's
  subject). The Confirmation probe pins the shipped default by its pre-registered
  rule; this document pins nothing.

### Consequences

* Good, because per owner the **page-1** point cost drops from *R(o)* to `ceil(R(o)/B)` as a
  no-fallback floor (for *B* ≤ 100 each batched query prices at the 1-point minimum under the
  published formula): the 8 × 750 estate's page-1 floor drops from 6,000 points — more than a
  full window — to **240 at B = 25**, under 5% of one window, and rescans price identically. An
  owner with *n* repositories pays `ceil(n/B)` page-1 points — an `n/ceil(n/B)`-fold reduction
  (24 repositories → 1 query, 24×; 26 → 2 queries, 13×); **only single-repository owners see
  none** (the worked table's degenerate row). The continuation term is untouched: a 1,000-head
  repository costs 10 points today and ~9 batched (a ~1.1× gain) — the floor this option
  removes is the per-repository *minimum*, not the branch-heavy tail. Fallback paths add
  bounded re-spend on top of the floors, quantified in the design as nominal no-retry
  logical bounds (up to the window's full per-repo pagination on a degrade; at most
  *B* − 1 duplicated page-1 points on a head-budget or continuation-time stop; a window's
  completed continuations on an age-cap re-fetch — each logical call may spend up to
  `MAX_ATTEMPTS` physical attempts).
* Good, because the §3 skip predicate's input is exactly as live as the snapshot it already
  consumes; no cache, no persisted snapshot, no cross-run reuse.
* Good, because `--plan` inherits the same reduction through the same seam.
* Good, because every **batch-shape anomaly** degrades to the existing per-repository path,
  with downshift so a rejected batch shape is not repeated; throttles keep their §4 semantics
  (pause, retry in place, requeue only on exhaustion); the closed per-alias family commits
  normally; and staging plus the one-door rule bound the router's misrouting cost at one extra
  per-repo pass by construction.
* Bad, because the discovery-to-scan window widens as stated above — silent-until-next-run
  effects on skip-current, policy/cutoff/cap classification, newly-created branches, and
  staged failures that commit after their cause has cleared, plus loud pinned-OID unit
  failures on the clone path — bounded by *B*, the age cap (which covers every staged item
  that can become a permanent record; the exempt staged throttle outcome commits only a
  deferral), and the `batchSize: 1` bypass.
* Bad, because the prefetch window is new stateful machinery: staging, an age cap, a head
  budget, and a downshift each add a rule that can misfire — though each misfire's designed
  outcome is the per-repo status quo, not a wrong snapshot.
* Bad, because per-alias error routing is new correctness surface on an adversarial input with
  zero misclassification budget — hence the closed family, the staging rule, the degrade
  default, and the scripted-envelope test bill below.
* Bad, because the degrade path's worst case spends more than either pure path (one failed
  batch plus the window's full per-repo pagination), and one throttled batch stalls *B*
  repositories' discovery at once rather than one — and a continuation-phase throttle — or a
  terminal *transient* retry, whose backoff pause also publishes through the shared bucket
  ([github.ts:2232-2233](../../scripts/github.ts#L2232)) — while
  failing only its own repository, arms a bucket-wide pause that every later continuation
  waits out ([github.ts:1966-1980](../../scripts/github.ts#L1966)): siblings still
  paginating can exhaust or hit an unfundable pause into their own repository-local
  outcomes, and completed siblings can age past the cap and force their solo re-fetch
  (affected, not failed).
* Neutral, because the REST listing spend (§5.A), the content path (ADR-0001), the database
  schema, and the §4 buckets, pause accounting, and taxonomy are untouched — the batched path
  *adds* a classifier stage and deliberately reroutes batched 502/504 and no-response from
  transient retry to degrade, retains the truncation-shape retry, catches every non-throttle
  pre-envelope throw from the batched page-1 call at the window boundary (the solo path's
  per-repository catch, reproduced through the lazy solo re-fetch — throttle throws keep the
  throttle door, continuation-phase throws stay repository-local), and sends *throttle-caused*
  window exhaustion to a window-scoped requeue while transient exhaustion degrades (the
  cause-tagged distinction): disclosed deltas, not taxonomy changes. Secondary-limit exposure is not proven either way: batching
  cuts the page-1 *request count* ~*B*× (less pressure on the per-minute point cap), but
  concurrency is set by owner fan-out, not request count — longer-lived batched calls can
  overlap *more*, not less — and beyond the published shared concurrency and CPU bounds GitHub
  reserves undisclosed checks. Per the drivers: a goal, not a guarantee.

### Confirmation

1. **Live cost probe with a pre-registered rule, committed like the boundary probe.** Corpus
   frozen first: repository sets per stratum are recorded before any measured try, and
   **every tested batch size must be exercised by at least one full same-owner batch of
   exactly *B* repositories per stratum** — a two-repository corpus cannot call itself
   B = 25. (The single-owner floor `ceil(n/B)` generalizes to `Σ over o of ceil(n(o)/B)` if a
   multi-owner corpus is ever used.) Candidate cells B ∈ {10, 25, 50} × two strata —
   single-page repositories (*p* = 1) and a paginating stratum (**> 100 heads, i.e. *p* ≥ 2**;
   exactly 100 heads is still one page) — each cell carrying its own interleaved **B = 1
   control arm** over the identical corpus (the control is the denominator, not a candidate,
   and is never gated as one) — **exactly 5 tries per cell**, candidate and control
   arms interleaved over the fixed corpus (a cell whose gate outcome is already decided by an
   unclean try may terminate early, its partial record committed with the cause), with **observed page counts recorded per arm and
   checked against the frozen corpus: a try whose observed count differs from the frozen
   depth — in either arm — is invalidated and re-run** (this subsumes the per-arm match:
   uncaught ref churn across a page boundary would otherwise silently change a control
   denominator, coherently grow both arms past the admitted spend, or walk a *p* = 1 corpus
   out of its stratum).
   Invalidation is bounded: a cell invalidated more than twice — dirty control or page-count
   drift — is committed as `invalid` with its cause rather than re-run unbounded, and an
   invalid cell fails the contiguous-prefix rule below like a failing one. A 502/504 in any
   arm fails its try unclean, terminates the cell early, and **quarantines the runner to the
   next reset epoch** before any further dispatch anywhere — the documented timeout penalty
   is unquantified, so no admission can price the current window after one.
   Instrumentation is identical in both arms and external to production code: **both arms are
   probe-authored queries carrying a per-call `rateLimit { cost }` field — the boundary
   probe's per-call method (its `bucketBefore`/`bucketAfter` deltas were sweep-wide, not
   per-call)** — with header deltas as a cross-check only, valid only within one reset window
   on an otherwise-quiet credential; the production query requests no `rateLimit` field and is
   not changed for measurement. A try is **clean** only if **every dispatch in it produced exactly one
   response and every response** classifies `ok` under §4 — zero retries, zero degrades, zero
   fallback activity, and a dispatch with no response is unclean by construction, not
   vacuously clean (a transient failure retried into success is not clean either) — every
   alias resolves and passes the full fail-closed validation battery, and no throttle,
   secondary, or resource-limit signal appears in any body or headers — HTTP 200 alone proves
   nothing, since GraphQL throttles ride 200s. **Control cleanliness is a prerequisite: a
   cell's B = 1 control tries must all be clean, or the cell is invalid and re-run — an
   inflated control denominator must not manufacture a pass.** Tries are **paired** — candidate try *k* and control try *k*
   run adjacently over the identical corpus — and the cost gate binds **per pair**: in the
   *p* = 1 stratum, every pair's candidate points ÷ control points must be ≤ ½, so one
   inflated observation can tighten only its own pair, never loosen another's (per-cell
   per-repository cost maxima are recorded as summary statistics, not gates). **Wall = the
   maximum batched page-1 call duration in the candidate arm** — the only call shape batching
   changes; continuation and control call durations are recorded informational, since a slow
   solo continuation exists identically in both arms and disqualifies nothing (full-snapshot
   elapsed time is recorded separately, informational). The probe measures *transport* cost
   and cleanliness of the query shapes — it does not run the production window machinery
   (the continuation-time stop and its fallbacks are fixtured in the scripted tests below,
   not exercised live); a try whose continuation phase would have tripped the production
   stop is flagged in the artifact, informational. Continuation costs reduce like page-1
   costs — per try, summed continuation points ÷ pages observed, the stratum's per-try
   maximum feeding the corrected-estate arithmetic. **A candidate B passes only if: every try in both strata is clean; its batched page-1
   wall maximum is ≤ 5 s; every *p* = 1 pair passes the half-cost gate; and — the absolute
   gate — every clean try's measured batched page-1 cost is ≤ 2 × `max(1, round(B/100))`
   points per batch in *both* strata (the formula predicts 1; 2 tolerates rounding drift,
   and a half-the-control-but-many-points result must not pass on the ratio alone).
   Shipped default = among candidates ≤ 25 whose every smaller candidate also passed (a
   non-monotone result — B = 10 fails while B = 25 passes — is committed as an anomaly and
   no default ships without decision-maker review, since the operator range's monotonicity
   assumption would be falsified), the one with the LOWEST measured per-repository page-1
   cost in the *p* = 1 stratum — the reducer is the maximum over the stratum's clean tries
   of (summed page-1 points across the try's batches ÷ repositories covered), and the
   corrected-estate arithmetic uses the same per-try maximum — ties to the smaller B:
   largest-passing is not a selection rule, cheapest-measured is.** Before acceptance the Worked-arithmetic floors are
   recomputed from the measured costs (the correction below), and the default ships only if
   the corrected 8 × 750 estate's page-1 floor stays under 10% of one window — otherwise
   the no-pass outcome fires. The corrected arithmetic must also *present* estate-level
   totals including the continuation term at measured per-page cost, for the worked estates
   under stated head-distribution premises (all-single-page, and uniform *p* = 2 at B = 25
   with formula-priced one-point calls — where 8 × 750 runs 240 + 6,000 points, still more
   than a window; the presented totals substitute the measured reducers for the formula
   prices): ratification sees the whole bill. The ship threshold binds on the page-1 term because that is the term this decision
   moves; an estate's continuation wall, where it has one, is disclosed, not hidden by the
   gate's scope. The cost gate binds on the *p* = 1 stratum only — a paginating stratum's
   candidate/control ratio has an algebraic floor of
   `(Σ over o of ceil(n(o)/B) + Σ over r of (pages(r) − 1)) / Σ over r of pages(r)` —
   `(ceil(n/B)/n + p − 1)/p` in the uniform single-owner case — above ½ whenever every
   repository paginates (*pages(r)* ≥ 2), so a half-cost gate there would reject batching
   precisely where it claims no
   win; the paginating stratum gates on cleanliness, wall, and the absolute page-1 cost
   gate — its continuation cost recorded, not gated (unchanged machinery).
   The B = 50 cell is informational only: raising the default past 25 widens the disclosed
   window and needs its own ratified change. **If no B ≥ 10 passes, that outcome is committed
   and this ADR returns to the decision-maker rather than shipping a default.** If measured
   cost exceeds the formula estimate anywhere, the arithmetic here is corrected to the
   measured values before acceptance. The runner carries the boundary probe's spend
   discipline, upgraded to this matrix's scale: admission is **per-tranche, not one-shot,
   and the tranche is the try** — before each paired try, the runner pre-admits that try's
   worst case (every candidate and control attempt at a conservative per-attempt cost bound
   with the boundary probe's headroom factor, times one plus the cell's remaining permitted
   invalidation re-runs) against the live `remaining`, sleeping to the reset epoch when
   short; a tranche whose worst case exceeds the bucket's *limit* itself is committed
   `infeasible` with its arithmetic — admission must fail loudly, never sleep-loop toward a
   reset that can never fund it (a B = 50, uniform *p* = 4 cell already needs 5,265 points
   for its five re-runnable pairs — more than one whole window), and the
   run ends with a full washout of its own throttle horizon
   ([benchBoundary.ts:146-160](../../scripts/benchBoundary.ts#L146),
   [benchBoundary.ts:215-224](../../scripts/benchBoundary.ts#L215)). One-shot whole-matrix
   admission cannot work here: the spend is dominated by the control arms the full-batch
   rule requires (a cell's control arm costs B × *p* points per try), and on the *minimum*
   corpus topology — each cell exactly one full batch (n = B) at uniform depth *p* — the
   clean-baseline matrix costs `850·p + 30` points at the published formula's one-point
   batch pricing (the absolute gate tolerates 2×; admission's conservative per-attempt bound
   covers that case): ≈ 1,730 at the minimum paginating depth
   (*p* = 2), crossing a full 5,000-point window near *p* = 6 before a single invalidation.
   A larger frozen corpus or heterogeneous page depths price higher by summing the recorded
   per-repository page counts — which is exactly what per-tranche admission computes from
   the frozen corpus (the scalar curve is illustrative; the admission bound is computed,
   never assumed) — and the permitted invalidation re-runs can triple a cell, so the matrix
   must be schedulable across multiple reset windows by construction. The artifacts land in
   [0002-benchmark/](0002-benchmark/) — the frozen corpus (`refs-corpus.json`), the
   append-only try journal (`refs-probe-journal.jsonl`), and the result (`refs-probe.json`) —
   evidence directories stay per-ADR; the boundary probe's own artifacts remain in
   [0001-benchmark/](0001-benchmark/). *(Amended prospectively at the Stage-P corpus freeze,
   riding PR-P for ratification: the sentence previously registered the 0001 directory.)*
2. **Scripted-envelope tests for the classified-staged-partitioned order**: a `NOT_FOUND`
   alias among *B* stages exactly one repository's fail-soft failure (committed at
   consumption: errors row in a run, `discoveryErrors` in plan; siblings' snapshots intact);
   a **mixed envelope** — one `NOT_FOUND` alias *plus* one missing/unrecognized alias —
   commits *no* per-alias outcome and degrades the window (staging); a **swapped-identity
   envelope** — alias *rN* carrying repository *rM*'s `nameWithOwner` — is a batch-shape
   anomaly and degrades (identity re-assertion); a **pathless
   `RATE_LIMITED`** classifies as throttle, never anomaly (ordering); `RATE_LIMITED` and
   field-observed `RATE_LIMIT` bodies **with `x-ratelimit-remaining: 0` headers** classify
   primary, and without them secondary, on the batched path (the PR #36 regression fixtures
   extended to batches, headers included); the SSO-fatal combination and a permission-shaped
   403 degrade-and-downshift with no batch-stamped permanent rows, and a redirect status, an
   unexpected 2xx shape, and a residual fatal status each degrade-and-downshift likewise; an **alias-rooted resource-limit error**
   (node-limit wording beside partial data) triggers degrade-and-downshift, not a
   per-repository errors row.
3. **Partial-response fail-closed test**: an envelope missing an alias with no matching error
   triggers the per-window degrade, and no repository is recorded as an empty snapshot.
4. **Degrade, downshift, and containment tests**: a batched 502 degrades the window (no
   same-size retry) and the owner's next batch runs at `floor(B/2)` (25 → 12, floor 1); a
   batched 500 retries transiently at the same size and degrades-and-downshifts only on
   exhaustion; the truncation shape (200, unparseable body, nonzero exit) retries transiently
   and degrades-and-downshifts only on exhaustion; a no-response degrades-and-downshifts (one
   disposition, deadline-kill included); a non-throttle throw from the batched pipeline — scripted output-cap,
   stream-error, spawn-failure, and a deliberate invariant throw — degrades-and-downshifts
   uniformly, where a *batch-only* invariant (scripted into the batch builder or router)
   leaves the lazy solo re-fetches *succeeding* with no permanent rows, and a *shared*
   fault (scripted into machinery both paths use) reproduces that one repository's errors
   row solo; the same throws in the continuation phase stage only that repository's failure
   with sibling snapshots intact and no downshift; **mixed exhaustion sequences** resolve by
   the any-throttle-evidence rule — throttle-then-transient and transient-then-throttle both
   stage `requeue-throttle`, an all-transient sequence degrades; **cause-tagged exhaustion**: throttle exhaustion stages the window as
   `requeue-throttle` while transient exhaustion degrades it; an age-cap expiry or head-budget
   stop falls back per-repo **without** downshifting; a **continuation-phase** fatal or
   throttle exhaustion stages that one repository's fail-soft outcome with completed sibling
   snapshots still consumed (or age-discarded to solo re-fetch where the shared pause
   horizon outlives the cap — the disclosed sibling effect) — and a scripted long-horizon
   continuation throttle shows later paginating siblings waiting the same bucket-wide pause
   and exhausting into their own repository-local outcomes, with a terminal *transient*
   continuation failure's backoff pause propagating to siblings the same way; degraded repositories that then succeed solo produce no permanent errors
   rows.
5. **Window-bound and lifecycle tests**: staged items are consumed in kept order and never held
   more than *B* repositories ahead; **no per-repository side effect precedes consumption** (an
   abandoned window writes no DB row, no per-repository JSONL event, no repository-scoped
   progress event — including for staged per-alias failures; transport telemetry excepted); a
   staged item older than the age cap at consumption is discarded and re-fetched
   per-repo (simulated pause mid-window), but a staged throttle outcome older than the age
   cap still commits its mode's throttle mapping (`requeue-throttle` in a run;
   `discoveryErrors` in `--plan`) — no mid-run re-queue; a window crossing the head
   budget completes its
   in-flight repository, stops prefetching, and batching resumes at the next window; a
   window whose continuation phase outlives half the age cap stops prefetching and defers
   the rest (planned bound, no downshift); the run
   `Aborter` stops batch and continuation dispatch at the new boundaries and in-flight calls
   drain without effects; `batchSize: 1` routes through the existing `listBranchHeads` call
   path with **unchanged orchestration** — same call sequence, same progress events, same abort
   boundaries (the normative bypass, asserted at both the client-call and orchestration
   level).
6. **Snapshot invariants unchanged**: the existing `listBranchHeads` validation battery (default
   re-assertion across pages, heads↔default pairing, duplicate/cursor/completeness guards)
   passes against batched page-1 + immediate per-repo continuation, and the never-cached
   property remains grep-true ([github.ts:2195](../../scripts/github.ts#L2195)).
7. **Spec and surface bill**: PROMPT.md §5.B amended to describe batched page-1 discovery, the
   variable-binding rule, the classify-stage-partition order with its governing one-door rule,
   the **cause-tagged exhaustion result**, the window bounds (age epochs for snapshots and
   failures, age cap, head budget) and downshift triggers, and the `discovery.batchSize` key
   (validation, default, monotonicity note, and its §3 config-hash treatment); §4's AS-BUILT
   note re-checked; config.ts parsing, config.schema.json, and their tests updated for the new
   key; EXPORTS.md updated if the public client surface changes; any new JSONL event token
   added to the logVocab pin.

## Pros and Cons of the Options

### Option 1 — Alias-batched GraphQL branch discovery

One query fetches page 1 of `refs` + `defaultBranchRef` for up to *B* same-owner repositories;
continuation pages complete at batch time; consumption stays sequential. Touches `github.ts`
(batch builder + envelope router), the two discovery call sites, and the configuration surface
(config.ts parsing, config.schema.json, docs); no database-schema change.

* Good, because the page-1 reduction is ~*B*× per owner at full batches and structural; the
  floor becomes one point per *B* repositories where repository counts are large — which is
  where the complaint lives.
* Good, because §5.B's structural guarantees (same-snapshot pairing, fail-closed validation,
  live observation each run) carry over unchanged in kind.
* Good, because the transport mechanism has in-repo evidence: 250–475 aliases repeatedly
  returned 200/ok at cost 1; the one contrary sample (M4) did not reproduce under the Step-C
  probe.
* Good, because failure containment degrades to the status quo per window, with downshift, and
  the staged envelope plus closed per-alias family bound misrouting at one extra per-repo pass.
* Bad, because the cost claim for *this* query shape rests on the published formula until the
  Confirmation probe measures it — the blob probes bound transport behavior, not refs pricing.
* Bad, because the batch envelope seam and the window machinery (staging, age cap, head budget,
  downshift state) are genuinely new correctness surface (`errors[].path` is not even surfaced
  by today's parser).
* Bad, because staleness between discovery and consumption widens by up to *B* repositories
  within the age cap, with the silent-until-next-run effects stated in the Decision Outcome.
* Bad, because the continuation term is unbatched — branch-heavy repositories gain little —
  and single-repository owners see no reduction at all.

**Variant — cross-owner batching (evaluated, deferred).** Filling batches across owners would
extend the reduction to the many-tiny-owners estate (the worked table's last row: 1,000 page-1
queries → 40). It is deferred rather than dismissed: owners are concurrent fail-soft fibers
([orchestrate.ts:328](../../scripts/orchestrate.ts#L328)), so a shared batcher couples their
lifecycles — one batch anomaly spans owner boundaries, and owner-scoped discovery outcomes need
cross-fiber routing — and the estates in the complaint are large-owner shapes. Recorded in
Follow-on as an evidence-gated extension sharing this option's seam.

**Variant — wave-batched continuation pages (evaluated, deferred).** Continuations could batch
too: one alias per still-paginating repository per wave, cursors bound as per-alias variables,
dropping a window's continuation cost from `Σ (pages(r) − 1)` to `max(pages(r) − 1)`. The same
staging, partition, and validation rules apply unchanged. Deferred because it adds a second
probed-and-fixtured batch shape (cursor-carrying aliases, waves that shrink as repositories
complete) for a tail whose estate-level weight is unmeasured; if the probe's branch-heavy
stratum shows the continuation term binding in practice, this variant rides the same seam and
staging rules but takes its own ratified decision — it changes the accepted continuation cost
shape and couples continuation failures across repositories, which this ADR's acceptance does
not cover.

### Option 2 — Change-detection skip via §5.A listing evidence

Persist each repository's last coherent `BranchSnapshot` (a schema addition); on later runs, skip
`listBranchHeads` for repositories whose fresh §5.A listing shows `pushed_at` unchanged **and**
whose listing `default_branch` matches the persisted snapshot's default (the listing value used
strictly as a *re-discovery tripwire*, never as the default's source — the §5.A decision to drop
it as data stands, [PROMPT.md:807-815](../../PROMPT.md#L807)); rediscover on any mismatch, plus a
periodic unconditional rediscovery to bound undetected drift.

* Good, because unchanged repositories cost **zero** GraphQL — on pure-rescan estates this beats
  every other option outright, including Option 1.
* Good, because the trigger data already rides the listing the run performs anyway:
  `pushed_at`, validated ([github.ts:1060-1069](../../scripts/github.ts#L1060));
  `default_branch`, present on the wire but today dropped unvalidated.
* Bad, because it creates the disqualified staleness class: correctness rests on
  "`pushed_at` unchanged ⇒ ref state unchanged", which GitHub does not precisely document, and a
  missed change **silently under-reports until the evidence moves or the periodic rediscovery
  fires** — a bound set by configuration and trust in a timer, not by observation. The
  default-branch tripwire closes the settings-change hole only to the listing's own propagation
  lag — and the tripwire itself needs plumbing today deliberately omits: `mapRestRepo` drops
  `default_branch` unvalidated ([github.ts:1039-1074](../../scripts/github.ts#L1039)), so
  carrying it means validating and representing a field the §5.A decision removed.
* Bad, because it needs new persistence and a schema migration: `run_unit_head` cannot
  reconstruct a snapshot — rows are per-run, carry no `treeOid`, and skipped dispositions store
  `commit_sha = ''` (they do keep the head's commit *date* in `scanned_commit_date`,
  [orchestrate.ts:579-606](../../scripts/orchestrate.ts#L579), but no OID) — so the full
  coherent `BranchSnapshot` must be stored anew, plus staleness bookkeeping.
* Bad, because the skip predicate's input is server-controlled evidence about *absence* of
  change — unverifiable from inside the tool, unlike every other fail-closed check in the
  discovery path.

### Option 3 — Git-transport discovery (`ls-remote --symref`, or a heads-wide filtered clone)

Replace the GraphQL query with git-protocol discovery over the ADR-0001 hardened transport, at
**zero** API points, in either of two variants. **(a)** One `ls-remote --symref` per repository:
all heads plus the HEAD symref (the default branch) in one un-paginated single-snapshot response
— but without `committedDate`/`treeOid`, which must then come from persisted metadata for
unchanged OIDs plus targeted object reads for changed ones. **(b)** One fresh
`--depth 1 --no-single-branch --filter=tree:0 --no-checkout` clone per repository: **one network
operation** that fetches every head's tip commit — carrying `committedDate` and the root `tree`
OID — *and* establishes the default branch (the clone sets local HEAD from the remote's active
branch); subsequent reads are local process spawns, not network. Variant (b) observes the full
§5.B data set fresh each run with **no persisted store at all**, at the price of a
per-repository pack negotiation and transfer every run.

* Good, because steady-state discovery leaves the point economy entirely; no hourly wall exists
  to hit.
* Good, because a git-protocol ref advertisement arrives as one un-paginated response — no
  cross-page churn window, no `MAX_PAGES` bound, no 10-second budget — better atomicity in
  exactly the dimension that bites paginated GraphQL, though git documents no transactional
  guarantee for the advertisement itself.
* Good, because it extends the direction ADR-0001 already chose and hardened, and variant (b)
  preserves the observe-live-every-run property with zero new persistence.
* Bad, because variant (a) embeds Option 2's persisted-metadata store plus a changed-head
  resolution path, and variant (b)'s per-run cost is a server-side pack computation per
  repository whose behavior at estate scale (tens of thousands of clone negotiations per run)
  is unmeasured — GitHub's git-read guidance ("15 operations/second/repository") is
  per-repository and thus not the open question; whether undisclosed abuse detection binds on
  aggregate fetch volume is unresolved either way — unmeasured here, and documented by GitHub
  only as a reserved right.
* Bad, because the read-only guard grammar and process-spawn surface grow (new git argv shapes;
  a clone plus local reads per repository per run in variant (b)), and empty-repository /
  unborn-HEAD / dangling-HEAD shapes need their own fail-closed mapping onto the heads↔default
  pairing invariants.
* Bad, because it is the largest §5.B rewrite of any option — this is the natural *next* ADR if
  the git transport keeps absorbing the pipeline, not the proportionate first step.

### Option 4 — Proactive budget pacing and spend-shaping

Implement the spec's deferred intent ([PROMPT.md:768-771](../../PROMPT.md#L768)): watch
`remaining`, pause the bucket *before* exhaustion, and spend what remains on the highest-value
repositories first (the kept order already sorts `pushed_at` DESC within an owner).

* Good, because it converts a mid-flight wall into a planned pause, and it composes with any
  other option.
* Good, because the raw signals exist — preflight snapshots both buckets' `remaining`
  ([preflight.ts:157-163](../../scripts/preflight.ts#L157),
  [orchestrate.ts:177-184](../../scripts/orchestrate.ts#L177)) and every response's
  `x-ratelimit-*` headers are parsed — though today they feed logs and the TUI only; the
  buckets track pause horizons and a pause budget, not remaining quota
  ([github.ts:1318-1353](../../scripts/github.ts#L1318)), so admission control is new plumbing,
  not a toggle.
* Bad, because it fails the first driver outright: the estate above still cannot complete
  discovery in one window; pacing and deferral do not count. PR #36 already made wall-hits
  survivable; this option only makes them tidier.

### Option 5 — Credential scaling

Authenticate as a GitHub App with per-organization installation tokens (5,000 points/hour base
per installation, scaling to 12,500 with repository/user count; GHEC installations carry a
10,000-point tier) or other qualifying credentials.

* Good, because installation budgets are **per installation**: an estate of *N* audited
  organizations gets *N* independent buckets even at the base tier, so the ceiling scales with
  exactly the dimension the complaint grows along.
* Good, because it composes with any spend-reduction option, and Apps install on personal
  accounts too, so the personal namespace is coverable — one more installation step per
  operator.
* Bad, because it is not a code-free change: preflight pins identity to the operator's `gh`
  user-token flow ([preflight.ts:91-139](../../scripts/preflight.ts#L91)), so per-owner token
  routing, App-auth plumbing, and a preflight identity redesign are all real surface.
* Bad, because the operational model breaks the tool's deployment story: a consulting operator
  must register an App and get it installed in *every audited organization* (and personal
  namespace) before the first scan — the adoption cost this tool's `gh`-credential design
  exists to avoid.
* Bad, because it scales the allowance, not the cost: the per-repository point floor remains,
  and every future estate pays the installation prerequisite again.

### Option 6 — Fused listing + discovery (owner-scoped nested query)

One `repositoryOwner(login: $login) { repositories(first: 100, after: $cursor,
ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) { pageInfo{…}
nodes { name … defaultBranchRef{name} refs(refPrefix: "refs/heads/", first: 100){…} } } }`
query — the affiliation restriction mirrors §5.A's `affiliation=owner` personal listing
([PROMPT.md:791-794](../../PROMPT.md#L791),
[github.ts:2290-2292](../../scripts/github.ts#L2290)); without it the connection admits
collaborator and organization-member repositories the REST lane excludes — pages through an
owner's repositories
with page-1 refs nested inside each node — replacing both the §5.A REST listing call and page-1
discovery in one stroke ([`RepositoryOwner.repositories`](https://docs.github.com/en/graphql/reference/repos#repositoryowner)
is the documented interface). Under the published formula, one outer 100-repository page plus
its 100 nested refs connections price at `round(101/100)` = **1 point per 100 repositories,
listing included**. The page count runs over *raw listed* counts —
`Σ over o of max(1, ceil(L(o)/100))`, the same one-query minimum per owner the REST
comparison uses (an empty connection still costs its discovery query) — because nested refs
are fetched before the client-side denylist, archived/fork filter, and
cap run: the 8 × 750 estate prices at 64 points only under a no-filtered-extras premise,
against Option 1's 240 at B = 25, and the REST listing requests disappear entirely.
Continuation pages for > 100-head repositories still run per-repository, exactly as in
Option 1.

* Good, because it carries the lowest nominal steady-state *GraphQL point* cost of any
  API-query option *that observes refs live* — one point covers 100 repositories' listing
  *and* page-1 discovery (Option 2's zero-for-unchanged rides persisted snapshots, the
  staleness class the drivers disqualify; Option 3's git-transport variants spend zero API
  points but pay per-repository transport instead — different units) — and the only
  identity variable is the owner login: no per-repository alias generation at all.
* Good, because listing metadata and refs come from one server-side read — per repository,
  the listing-to-discovery gap disappears.
* Bad, because the §5.A listing paginates the whole owner to completion before any
  client-side filter, sort, or cap runs
  ([github.ts:2168-2192](../../scripts/github.ts#L2168),
  [PROMPT.md:795-816](../../PROMPT.md#L795)): refs fetched on early outer pages age across
  the owner's entire remaining listing and post-processing — an owner-wide
  discovery-to-consumption window with no *staleness* bound analogous to Option 1's *B* and
  age cap (only coarse transport bounds — `MAX_PAGES`, deadlines, retry limits — which bound
  duration, not decision staleness) unless this option grows its own window machinery. Wider
  than Option 1's *B*-bounded, age-capped window, not narrower.
* Bad, because it rewrites the §5.A listing lane in the same stroke: the REST listing's
  validated field battery (`mapRestRepo`,
  [github.ts:1039-1074](../../scripts/github.ts#L1039)), denylist evidence, `maxReposPerOrg`
  cap, and owner discovery all re-plumb onto GraphQL shapes and PROMPT.md §5.A is
  re-specified — the largest-blast-radius GraphQL option, against this ADR's own scope
  statement that listing is unchanged.
* Bad, because error routing is positional, not aliased: `errors[].path` indexes into
  `repositories.nodes[i]`, so attributing a failure to a repository depends on the node
  list's own integrity — a weaker handle than per-alias roots on exactly the adversarial
  surface the one-door rule exists to bound.
* Bad, because nested refs are pre-paid server-side for repositories the run then discards
  client-side (the §5.A denylist, archived/fork filter, and cap all run *after* listing):
  today a discarded repository costs a slice of a REST page; fused, it costs that slice plus
  a full 100-ref sub-selection — worst case `maxReposPerOrg` discards most of a large owner's
  fetched refs.
* Bad, because the whole owner's listing *and* discovery ride one query lane: a single
  anomaly or throttle stalls both, and each page's response weight (100 repository nodes ×
  ~200 ref/commit nodes) presses the same 10-second budget the drivers warn about, with no
  in-repo measurement for this shape.
* Neutral-to-bad, because once Option 1 lands the remaining win is second-order: 240 → 64
  points on the 8 × 750 estate (no-filtered-extras) — both under 5% of one window — while
  the saved REST requests (~1 per 100 repositories) come from a budget that is not under
  pressure. Rejected as
  disproportionate to its blast radius; recorded in Follow-on as the shape to evaluate if the
  post-batching discovery floor ever binds again.

## More Information

### Limits this decision is measured against

**Current GitHub documentation and response headers are authoritative** — over this table and
over ADR-0001's. The fuller limits record, retrieved 2026-07-27/28, lives in
[ADR-0001, More Information](0001-file-content-acquisition-strategy.md#more-information); two
entries were re-verified for this decision on 2026-08-04 from GitHub's GraphQL rate-limit
documentation:

| Fact | Value (retrieved 2026-08-04) |
|---|---|
| Point formula | requests per unique connection, assuming `first`/`last` limits are reached, ÷ 100, rounded to nearest; **minimum 1 per query**; declared subject to change |
| Timeout penalty | requests exceeding ~10 s return 502/504 **and** "additional points will be deducted from your primary rate limit for the next hour" |

The primary budget for ordinary user/PAT authentication — including GHEC users — remains 5,000
points/hour as both retrievals record; higher tiers require qualifying App/OAuth or installation
credentials, and Option 5 discusses the per-installation shape. All arithmetic in this document
is scoped to github.com under an operator `gh` user token; GHES limits are site-configurable
(and may be disabled), so on other hosts the observed headers are the only model.

### Worked arithmetic

**No-fallback page-1 floors** under the published formula. The continuation term
`Σ over r of max(ceil(max(heads(r), 1)/100) − 1, 0)` adds to every column equally and is
excluded — batching does not reduce it (see Option 1's wave variant for the shape that would).
Each batched query at *B* ≤ 100 prices at the 1-point minimum. Batching is per-owner, so the
estate's *shape* — not just its total — sets the cost:

| Estate shape | Kept repos *R* | Today (= *R*) | B = 25 | B = 50 |
|---|---:|---:|---:|---:|
| 1 org × 1,000 | 1,000 | 1,000 (20% of window) | 40 | 20 |
| 8 orgs × 750 | 6,000 | 6,000 (> 1 window) | 240 | 120 |
| 25 orgs × 400 | 10,000 | 10,000 (≥ 2 windows) | 400 | 200 |
| 1,000 owners × 1 | 1,000 | 1,000 | 1,000 | 1,000 |

The last row is the honest degenerate case: per-owner batching buys nothing where no owner has
a second repository. That estate was not the complaint — and the cross-owner variant recorded
under Option 1 and Follow-on is the shape that would address it if it ever is.

### Measured outcome (Stage P probe, 2026-08-05)

The Confirmation-1 probe ran to completion against the frozen corpus (100 synthetic fixture
repositories under the `sondrateconsulting` organization; corpus, append-only try journal,
and result all in [0002-benchmark/](0002-benchmark/), the journal and result committed
together at completion): 26 try rows — **25 completed pairs plus one candidate-only attempt
terminated by the 504 below** — 976 dispatches, 975 measured points, no invalidations, no
resume. **The pre-registered rule pinned the default at B = 25.**

Measured values replaced no formula estimates because they differed nowhere: every
**cost-readable** batched page-1 call priced at **exactly 1 point** at B ∈ {10, 25, 50} —
the published formula held exactly for this query shape, and the absolute gate's 2×
tolerance was never consumed — and every continuation page priced at exactly 1 point. (The
one call with no readable cost is the 504'd batch below: a timed-out request returns no
rider, and its documented penalty is deducted unobserved.) Per-repository page-1 reducers
(max over clean tries, *p* = 1 stratum): 0.10 at B = 10, **0.04 at B = 25**, 0.02 at
B = 50 (informational). Candidate/control pair ratios in the *p* = 1 stratum: 0.10 / 0.04 /
0.02 — all far under the ½ gate; the paginating stratum's ratios (0.55 at B = 10, 0.52 at
B = 25) sat above ½ exactly as the algebraic floor above predicts (the reason that gate
binds the *p* = 1 stratum only). Batched page-1 walls tracked response size: 1.5 s / 2.2 s
/ 4.0 s in the *p* = 1 stratum and 3.6 s / 4.77 s in the paginating stratum at B = 10 / 25
— inside the 5 s gate. The informational **B = 50 paginating cell drew an HTTP 504 on its
first 50-alias batch** (5,000 requested ref nodes): per the pre-registered rule the try
failed unclean, the cell terminated, and the runner quarantined itself to the next reset
epoch — a live corroboration of the timeout caution above, at a shape the operator range
never reaches. The header-delta cross-check did **not** independently corroborate the
rider costs and is recorded as noisy, nothing more: the quarantine sleep straddled a reset
window (invalidating the run-level before/after bucket delta), and 16 of the 50 clean arm
summaries show a per-arm delta above their rider-cost sum (worst +4) — the
otherwise-quiet-credential premise did not hold. Every gate and reducer rides the per-call
rider alone, as pre-registered.

Both candidates passed every gate, so the Worked-arithmetic floors above stand as
**measured**, not merely estimated, and the ship threshold passes: the 8 × 750 estate's
corrected page-1 floor is **240 points — under 10% of one window**. Continuation-inclusive
estate totals under the stated premises (measured reducers; single-repository owners keep
the formula's 1-point-per-query floor):

| Estate shape | Today (page 1) | B = 25 page-1 (measured) | All-single-page total | Uniform *p* = 2 total |
|---|---:|---:|---:|---:|
| 1 org × 1,000 | 1,000 | 40 | 40 | 1,040 |
| 8 orgs × 750 | 6,000 | 240 | 240 | 6,240 |
| 25 orgs × 400 | 10,000 | 400 | 400 | 10,400 |
| 1,000 owners × 1 | 1,000 | 1,000 | 1,000 | 2,000 |

The uniform-*p* = 2 column shows the continuation term unmoved by this decision — the
disclosed scope: this option removes the per-repository page-1 minimum, not the
branch-heavy tail. **The `discovery.batchSize` operator range's ceiling is therefore the
probe-pinned default, B = 25**, recorded here for the implementation stage. Per this
repository's practice the flip to `accepted` rode the probe PR only on rvo's explicit word:
**rvo ratified Option 1 with the pinned default B = 25 on 2026-08-05** (the Stage-P
ratification gate on PR #40), and the status above records it.

### Review history

This ADR is under the adversarial review loop this repository uses for decision documents
(Codex, gpt-5.6-sol; five initial rounds, then reopened by the decision-maker for up to five
more — rounds 6–10). Rounds and their outcomes are recorded here as they complete;
disagreements are recorded rather than smoothed.

**Round 1 (2026-08-04): REVISE — 15 P1, 4 P2; every finding verified against the code and
accepted.** Headlines: the staleness consequence originally claimed prefetch widening could
only surface as loud clone failures — false; skip-current, policy/cutoff/cap classification,
and newly-created branches are silent-until-next-run paths, now stated. The arithmetic ignored
the per-owner window boundary. The router was specified against an envelope seam that discards
`errors[].path` and fails all body errors call-fatally. Inline identity interpolation was
unsafe (`isCanonicalIdentity` deliberately admits GraphQL metacharacters) — variables-only is
normative. Option 5 was strawmanned; Option 3 was missing its strongest variant. Factual fixes:
the symlink REST lane survives T2c; skipped `run_unit_head` rows carry a date but no OID; GHEC
membership alone does not raise the user bucket to 10,000; `RATE_LIMITED`/`RATE_LIMIT` classify
primary only with `x-ratelimit-remaining: 0`; preflight's snapshot feeds the TUI, not admission
control; cost equations relabeled nominal successful-path floors.

**Round 2 (2026-08-04): REVISE — 15 P1, 3 P2; accepted in full.** The review moved to the
design's state machine; five rules were added: the snapshot **age cap**, the window **head
budget**, **continuation-phase failure containment**, the **normative bypass**, and the
**partitioned classifier** (the prior order would have let today's generic 2xx-fatal arm
swallow alias-routed errors and misrouted alias-rooted resource-limit errors into permanent
per-repository failures). The probe rule was rebuilt (control cell, clean-try definition,
cost-benefit gate, ≤ 25 ceiling, no-pass outcome). The arithmetic gained the continuation term
and the per-owner REST form; "guaranteed stall / before any scanning" became the precise
rescan-rate argument. Cross-owner batching became an evaluated, deferred variant; Option 5's
self-contradiction was removed; the `RATE_LIMIT` spelling was marked field-observed; document
authority inverted to current-docs-and-headers.

**Round 3 (2026-08-04): REVISE — 17 P1, 5 P2; accepted, with two items delegated to the
implementation bill by name** (the config-hash treatment of `discovery.batchSize`, constrained
to not perturb the §3 skip predicate; per-alias family extension, evidence- and
ratification-gated). The design gained **envelope staging**, the **one-door rule** with
call-scope dispositions, the ordered 5xx exception, the defined **age epoch**, **head-budget
mechanics**, **downshift triggers and arithmetic**, **lazy fallback**, `Aborter` integration,
and the **operator surface**. The probe metric was defined; the REST comparison moved to raw
listed counts; underfilled batches were fixed (only singletons gain nothing); fallback re-spend
was stated; arithmetic was scoped to github.com. Option 3(b) improved under review (a
`--no-single-branch` filtered clone establishes HEAD in one network operation); wave-batched
continuations were evaluated and deferred; `--plan`'s distinct fail-soft shape was cited.

**Round 4 (2026-08-04): REVISE — 21 P1, 11 P2; accepted in full.** The reviewer stress-tested
the round-3 rules pairwise and the order itself was wrong: staging preceded call-scope
classification, so a pathless `RATE_LIMITED` would have degraded instead of pausing — the
normative order is now classify → stage → partition, matching today's errors-before-envelope
order ([github.ts:848-851](../../scripts/github.ts#L848)). Blanket 5xx-degrade was narrowed to
the documented timeout shapes (502/504) with other 5xx keeping transient retry; no-response and
client deadline kills were shown to be indistinguishable in this harness (status-0 parse) and
now share one degrade disposition; residual fatal statuses degrade under the one-door rule
rather than stamping *B* records; window `requeue-throttle` is disclosed as a batched-analog
delta with its `--plan` mapping (per-repository counts, never mislabeled throttle-as-failure).
Staging was extended through consumption — no side effect of any kind before the consuming
repository's abort check — and the age cap now covers staged failures, with the epoch defined
as the retained attempt's dispatch. The probe was made executable: frozen corpus, interleaved
arms, header-delta instrumentation (the production query has no `rateLimit` field — the
control arm was unmeasurable as previously written), exactly-5-try max statistics, per-call
wall bounds, and the cost gate scoped to the *p* = 1 stratum after the reviewer proved the
half-cost gate algebraically unsatisfiable for any *p* ≥ 2 stratum. The uniqueness claim was
corrected (Option 3(b) also removes the floor with live observation; Option 1 wins on
containment, not uniqueness); the touched-surface list gained the configuration layer; the
config range was tied to validated sizes via a stated monotonicity assumption; family
extension now requires evidence and ratification, not fixtures alone; reduction factors are
exact (`n/ceil(n/B)`); the REST term handles zero-repo owners; degrade re-spend is
`Σ pages(r)`, not *B*. Wording fixes: "siblings affected-but-not-failed", "batch-size
default", credential-shape scoping, abort-boundary citation, step numbering.

**Round 5 (2026-08-04): REVISE — 14 P1, 3 P2. The five-round cap was reached; the loop closed
WITHOUT the reviewer's approval.** All 17 findings were verified and applied **after** the cap,
so the text above incorporates them **unreviewed** — this paragraph is the disclosure. What
they added: **cause-tagged exhaustion** (today's untagged `ThrottleExhausted` conflates
throttle- and transient-exhaustion, which this design dispositions differently — requeue vs
degrade); the traceless-staging guarantee narrowed to *per-repository* effects (transport
telemetry and shared bucket state are call-time and cannot be discarded); pre-envelope
transport failures and the truncation-shape retry ([github.ts:2249-2252](../../scripts/github.ts#L2249))
mapped into the disposition table; failure age epochs defined (an unfundable-pause exhaustion
stages with no dispatch); the *B* = 1 parity claim scoped to configuration (degrades inside a
live window keep call-level parity only); duplicated-continuation attribution moved from the
degrade path (whose envelope is page-1-only) to the age-cap path; fallback bounds relabeled
nominal no-retry; and the probe hardened again — full same-owner batches required per tested
size, control-arm cleanliness as a prerequisite, per-arm page-count matching, *p* ≥ 2 (not
≥ 100 heads) for the paginating stratum, per-call `rateLimit{cost}` in both probe arms (the
boundary probe's per-call method; its bucket deltas were sweep-wide — the header-delta method
previously described was unsound under concurrent traffic), every-physical-response
cleanliness, and a contiguous-passing-prefix rule so a non-monotone result cannot silently
ship a default that falsifies the operator range's monotonicity assumption. "Default B = 25"
became "probe candidate". **Standing positions at close:** the reviewer's final verdict on the
pre-round-5 text was REVISE; no round has returned APPROVE. The recommendation itself —
Option 1, alias-batched page-1 discovery — was never contested in any round; every finding
targeted claims, arithmetic, rule completeness, or evidence discipline. Ratification should
weigh this document as five-times-adversarially-reviewed but not reviewer-approved.

**The loop was reopened (2026-08-04): the decision-maker extended the adversarial review by up
to five further rounds (6–10) under a committed continuation handoff, superseding the
five-round cap and the closing status recorded in the round-5 entry above.**

**Round 6 (2026-08-04): REVISE — 8 P1, 7 P2; every finding verified against the sources and
applied.** The round opened with an application audit of the 17 post-cap round-5 fixes: 16
were faithful; one was not implementable as written — "invariant and programmer errors escape
as today" named no discriminator (the output cap, the argv guards, and kill-escalation all
throw the same untagged `GithubApiError`,
[github.ts:176](../../scripts/github.ts#L176)/[332](../../scripts/github.ts#L332)/[418](../../scripts/github.ts#L418),
and none is retried by the attempt loop) and misstated today's behavior (the solo seam
blanket-catches every throw into that repository's fail-soft outcome,
[orchestrate.ts:521-538](../../scripts/orchestrate.ts#L521)). The design now catches every
pre-envelope throw at the window boundary and degrades-and-downshifts uniformly — no
discriminator, no new global-fatal path, persistent faults converge to *B* = 1. The fresh
pass then: completed the downshift trigger list (truncation and 5xx exhaustion, pre-envelope
throws — the output cap is direct size evidence); disclosed staged-failure staleness as the
window's fourth effect (a cleared cause still records its staged failure, age-cap-bounded);
added the head-budget stop's duplicated page-1 spend (≤ *B* − 1 points) to the fallback
accounting; gave the probe the boundary probe's admission and washout with its real spend
stated (≈ 1,760 points at *p* = 2 — control arms dominate), per-pair cost gating (one
inflated control try can no longer loosen the gate), a dispatch-anchored cleanliness rule (a
no-response try is unclean, not vacuously clean), a page-1-scoped wall gate (a slow solo
continuation, identical in both arms, no longer disqualifies), an invalidation cap, and the
general-form ratio floor; added and rejected a sixth considered option (the fused
owner-scoped listing+discovery query — cheapest live-observation shape, largest blast
radius, recorded in Follow-on); re-labeled the wave-batched continuation variant as its own
ratified decision; rephrased Option 3(b)'s abuse-detection sentence as unresolved; defined
the head budget as a resident-memory bound; and recorded this reopening itself per the
reviewer's governance finding.

**Round 7 (2026-08-04): REVISE — 7 P1, 2 P2; every finding verified against the sources and
applied.** The application audit accepted 12 of 15 round-6 applications and faulted the new
uniform-disposition passage three ways, all confirmed: it swallowed the throttle door (an
unfundable pause throws `ThrottleExhausted` *before* dispatch,
[github.ts:1918-1927](../../scripts/github.ts#L1918), and must stage `requeue-throttle`, not
degrade) and ignored continuation-phase containment — the uniform arm is now scoped to
non-throttle throws from the batched page-1 call, with both precedence routes stated; its
rationale claimed one shared error class where a reader failure rethrows the original value
unchanged ([github.ts:443-451](../../scripts/github.ts#L443)) and `Bun.spawn` failures
arrive unwrapped — the rationale is now "nothing reliable to route on", not "one class"; and
its convergence claim ignored the per-run downshift reset — convergence to *B* = 1 is now
scoped within-run, with the cross-run non-memory stated. The probe's admission was rebuilt
as per-tranche (worst case × headroom × remaining permitted re-runs against live
`remaining`), with the honest matrix curve `860·p + 40` — the clean baseline alone crosses a
window near *p* = 6, so one-shot admission cannot work. The age cap gained the §4-mandated
exemption: a staged throttle outcome commits as `requeue-throttle` at any age
([PROMPT.md:733-741](../../PROMPT.md#L733) — no mid-run re-queue). Option 6 was corrected
twice: fused listing does not "close" the staleness gap — §5.A paginates the whole owner
before filtering ([github.ts:2168-2192](../../scripts/github.ts#L2168)), so early-page refs
age across the entire listing, an unbounded owner-wide window, now a Bad bullet — and its
arithmetic now runs over raw listed counts `L(o)`, the 64-point figure marked
no-filtered-extras. The consequence summary gained the fourth widened-window effect, and the
prefetcher is named what it is: tumbling windows, disjoint, never refilled.

**Round 8 (2026-08-05): REVISE — 13 P1, 3 P2; every finding verified against the sources and
applied.** The application audit accepted six of nine round-7 applications and caught three
consistency escapes: the tranche-admission multiplier under-counted by one (worst case is the
current execution *plus* the remaining re-runs — now `1 +` re-runs), and two summary claims
still spoke unqualified where the detailed rules carry exceptions (uniform age bounding — the
staged throttle outcome is exempt but commits only a deferral, so everything that can become
a permanent record stays age-bounded; the Neutral bullet's "every pre-envelope throw" —
re-scoped to non-throttle batched-pipeline throws). The fresh pass then found the round's
substance: the "exhaustive" downshift list omitted the step-3 call-scope fatals (added — they
downshift under the uniform rule); mixed throttle/transient retry sequences had no
cause-selection rule (added: **any-throttle-evidence tags the exhaustion throttle**, both
orderings fixtured); throws from the new classification/validation/staging/partition
machinery had no route (the catch boundary is now the whole batched pipeline); the probe's
B = 1 cell could never pass its own self-pair, making the contiguous prefix impossible
(cells restructured: candidates {10, 25, 50}, B = 1 is the ungated control arm); the ½-ratio
gate proved nothing absolute (a new absolute gate — measured page-1 cost ≤ 2 ×
`max(1, round(B/100))` per batch in both strata — plus a corrected-estate threshold: the
default ships only if the recomputed 8 × 750 page-1 floor stays under 10% of a window);
largest-passing-B was not cost-rational (selection is now cheapest-measured with
smaller-B ties); "exactly 5 tries" conflicted with the unquantified 502/504 penalty (a
timeout response now terminates its cell and quarantines the runner to the next reset
epoch); the matrix curve was restated on its minimum-topology premise (`850·p + 30` with
admission computed from the frozen corpus, never the scalar); Option 6's sketch gained
`ownerAffiliations: [OWNER]` (the REST lane's `affiliation=owner`,
[github.ts:2290-2292](../../scripts/github.ts#L2290)) and the `max(1, …)` per-owner
minimum; the invariant-throw fixture was split batch-only-vs-shared (a batch-only defect's
solo re-fetches *succeed*); the head budget gained its run-wide envelope
(`concurrency.organizations ×` window bound + `MAX_PAGES` overshoot); and Option 6's "no
bound at all" was tightened to "no staleness bound" (transport bounds exist, decision-
staleness bounds do not).

**Round 9 (2026-08-05): REVISE — 8 P1, 4 P2; every finding verified against the sources and
applied.** The application audit accepted 14 of 16 round-8 applications; the two shortfalls:
the step-3 downshift fixtures covered only SSO/403 (redirect, unexpected-2xx, and
residual-status fixtures added), and round-8's "evaluate corrected estate cost including
continuations" had been applied as a page-1-only gate — the acceptance now also *presents*
continuation-inclusive estate totals under stated head-distribution premises (uniform
*p* = 2 puts 8 × 750 at 240 + 6,000 points — still more than a window; the ship threshold
stays on the page-1 term this decision moves, and the reviewer's own mid-round check
confirmed the `850·p + 30` curve). The fresh pass found: the selection metric had no reducer
(now: maximum over the *p* = 1 stratum's clean tries of summed page-1 points ÷ repositories,
reused by the corrected-estate arithmetic); the frozen corpus did not pin observed depth — a
coherent both-arms page growth could outspend admission or walk the *p* = 1 stratum
(frozen-vs-observed depth equality is now the invalidation rule, subsuming the per-arm
match); a branch-heavy window could legally paginate past its own age cap and arrive
all-expired (a third planned bound: a window whose continuation phase exceeds half the age
cap stops prefetching — no downshift); "sibling snapshots intact" overclaimed under a
bucket-wide pause horizon (disclosed and fixtured: paginating siblings wait the same
horizon, [github.ts:1966-1980](../../scripts/github.ts#L1966), and can exhaust into their
own repository-local outcomes); the live-observation uniqueness count omitted Option 3(a)
(now four options, with (a)'s OID-keyed immutable metadata argued); Option 6's "lowest cost
of any live-observation option" contradicted Option 3's zero API points (now scoped to
GraphQL point cost among API-query shapes, units named); the `850·p + 30` curve is labeled
one-point-formula baseline; the batch-size bullet's "response weight in the probed range"
was corrected to bytes-only (server weight unprobed — the probe's subject); the SSO
whatever-the-status claim was scoped to the classifier's actual 403/429 read
([github.ts:792-796](../../scripts/github.ts#L792)); and the `RepositoryOwner`
documentation link was repointed at GitHub's current per-category reference (the interfaces
URL now lands on a generic index — verified live).

**Round 10 (2026-08-05): REVISE — 11 P1, 3 P2. The extended ten-round cap was reached; the
loop closed WITHOUT the reviewer's approval.** All 14 findings were verified and applied
**after** the cap, so the text above incorporates them **unreviewed** — this paragraph is
the disclosure, the same pattern round 5 used. The application audit accepted 11 of 12
round-9 applications (the continuation-containment fixture now admits that a shared pause
can age completed siblings into solo re-fetch). What the final findings changed: admission
tranches dropped to the *try* (a B = 50, *p* = 4 cell's 5,265-point worst case can never fit
one window — a tranche whose worst case exceeds the bucket's *limit* is now committed
`infeasible`, never sleep-looped); the continuation-time stop was renamed what it is — a
dispatch-boundary stop trigger with worst-case pre-dispatch admission (spawn deadline plus
pause horizon), not a duration guarantee, its in-flight repository completing and the age
cap remaining the net, its deferrals joining the head-budget stop's fallback accounting;
every fallback bound is labeled nominal no-retry logical spend (`MAX_ATTEMPTS` physical
attempts each, penalties additive); the probe's scope is stated (transport cost and
cleanliness — the window machinery is fixtured in scripted tests, not exercised live, with
would-have-stopped tries flagged) and continuation costs got the same per-try-maximum
reducer as page-1; **the batch selection gained per-alias identity re-assertion**
(`nameWithOwner` checked against the alias's bound variables — a swapped-variables envelope
is a batch-shape anomaly, fixtured; the REST lane's identity check has had this since §5.A,
[github.ts:1039-1059](../../scripts/github.ts#L1039)); the staged-throttle age exemption
now names both consumption mappings (`requeue-throttle` in a run, `discoveryErrors` in
`--plan`); terminal *transient* backoff pauses are disclosed as propagating bucket-wide
exactly like throttles ([github.ts:2232-2233](../../scripts/github.ts#L2232)), fixtured;
Option 6's cost superlative is scoped to live-ref-observation API-query options (Option 2's
zero-for-unchanged rides the disqualified staleness class); the "seconds-wide" gap duration
was dropped (branch units can queue behind long sibling scans); the batch-size byte claim
was replaced with field arithmetic marked unmeasured; and Option 3's "strictly better
atomicity" was hedged to the un-paginated dimension git actually provides.

**Loop status (FINAL): ten rounds run, REVISE × 10; no APPROVE round occurred. The loop is
closed capped-not-converged.** The recommendation itself — Option 1, alias-batched page-1
discovery — was never contested in any of the ten rounds; every finding targeted claims,
arithmetic, rule completeness, or evidence discipline. Ratification should weigh this
document as ten-times-adversarially-reviewed but not reviewer-approved, with the round-10
applications additionally unreviewed.

### Follow-on work

* **Option 2 as an evidence-gated later layer.** If a measured estate shape shows batched
  discovery still binding, Option 2's skip can ride *on top* of batching — but only behind a
  `pushed_at` reliability study and an explicit staleness-bounding rule, per the Decision
  Drivers.
* **Cross-owner batching** (Option 1's deferred variant) if many-tiny-owner estates ever become
  the complaint: same seam, new cross-fiber containment design, its own review.
* **Wave-batched continuation pages** (Option 1's second deferred variant) if the probe's
  branch-heavy stratum shows the continuation term binding in practice: same seam, same
  staging and partition rules, one new probed batch shape, its own ratified decision.
* **Option 6's fused owner-scoped query** if the post-batching discovery floor ever binds
  again: it subsumes the listing lane and re-prices page 1 at
  `max(1, ceil(L(o)/100))` points per owner, but needs the §5.A re-specification and the
  positional-routing containment work its option notes — its own ADR, not an amendment.
* **Option 3 as the long-arc direction.** If the git transport continues absorbing the pipeline
  (the ADR-0001 trajectory), git-protocol discovery deserves a first-class evaluation — variant
  (b)'s one-operation filtered clone measured for pack-negotiation cost at estate scale, and
  the empty/unborn/dangling-HEAD shapes mapped onto the pairing invariants — benchmarked and
  fidelity-checked like ADR-0001's Step C.
* **Option 4's `remaining` watch** remains the spec's own recorded intent
  ([PROMPT.md:768-771](../../PROMPT.md#L768)) and composes with the chosen option; it is
  operability polish, not rate-limit relief, and is not scheduled by this ADR.
