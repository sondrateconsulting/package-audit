# Plan: implement ADR-0002 — alias-batched refs page-1 branch discovery

Status: pre-implementation plan, written at the close of the ADR's ten-round adversarial
review (Phase B of the review-loop continuation handoff — a spent session brief removed from
the tree once both its phases completed; the loop's authoritative record is the ADR's Review
history), then revised through one codex plan review (§12). **You, the reader, are assumed to be a fresh implementation session with no
other context: this document plus the files it cites are the complete brief.** §12 is the
ledger the implementation fills in as its own review loops run.

Governing texts, in order: ADR-0002's **Decision Outcome → "The design, concretely"** (the
normative rule set: batch shape with identity re-assertion, operator surface, staged windows,
the classify → stage → partition envelope seam under the one-door rule, cause-tagged
exhaustion with the any-throttle-evidence rule, window bounds, degrade-and-downshift,
`batchSize: 1` bypass) and its **Confirmation checks 1–7** in
[0002-branch-discovery-rate-limit-strategy.md](../adrs/0002-branch-discovery-rate-limit-strategy.md).
This plan adds no requirements to that bill and re-decides none of it; it sequences and
operationalizes it against this repository. Where this plan paraphrases the ADR and the two
disagree, the ADR wins.

## 1. Mission and PR shape

Two PRs, strictly ordered, with a decision-maker gate between them:

* **PR-P (probe + ratification).** The pre-registered live cost probe (Confirmation check 1)
  is built, reviewed, run against real GitHub, and its artifacts committed; the ADR's
  arithmetic is corrected to measured values; the batch-size default is pinned by the probe's
  rule (or the no-pass/anomaly outcome is committed instead). This PR carries the
  ratification ask: rvo either ratifies (the `proposed → accepted` status flip rides this PR
  after rvo's explicit word — the plan schedules the ask, it never performs the flip on its
  own) or the ADR returns to the decision-maker and **Stage I does not start**.
* **PR-I (implementation).** Branched only after **PR-P has merged** (the evidence, the
  corrected ADR, the pinned default, and the accepted status must all be on `main` — that is
  the base condition, not merely "rvo said yes"). The batched discovery build, in dependency
  order, each step red → green TDD, `/codex` as outside voice on every substantial step,
  ending with a `/santa-loop` gate at an explicit **7-round ceiling** before rvo's merge
  review.

Mirrors ADR-0001's arc (harness/evidence PRs → Step-D ratification → T2c implementation).
Base PR-P on `main` after PR #38 (the ADR itself) has merged; if #38 is still open when you
start, stack PR-P on its branch (`claude/graphql-rate-limit-madr-2c2d90`) and say so in the
PR body — never duplicate the ADR text into a second branch.

## 2. State of the world (as of this plan's commit)

* ADR-0002 is `proposed` on PR #38, **ten-times-adversarially-reviewed, REVISE × 10, loop
  closed capped-not-converged; round-10 fixes applied post-cap, unreviewed** — the ADR's
  Review history is the authoritative record. Never describe the ADR as reviewer-approved;
  the recommendation itself was never contested in any round.
* The suite is 2,608 tests, ~30 s (`bun test`); CI also runs typecheck, workflow audit, and
  README export-recipe checks. All green at plan time.
* Nothing of the design exists in code yet: `parseGraphqlEnvelope` discards `errors[].path`,
  the solo path classifies any 2xx body error call-fatally
  ([github.ts:821-825](../../scripts/github.ts#L821)), `ThrottleExhausted` is untagged
  ([github.ts:2262-2263](../../scripts/github.ts#L2262)), discovery is strictly
  one-repository-per-query ([github.ts:2322](../../scripts/github.ts#L2322)), and `Config`
  has no `discovery` key ([config.ts:37-60](../../scripts/config.ts#L37)).
* Two items are **delegated to this plan by the ADR by name** (Review history rounds 3–5):
  the config-hash treatment of `discovery.batchSize` (step I5 — constraint: must not perturb
  the §3 skip predicate) and the per-alias `NOT_FOUND`/`FORBIDDEN` family-extension protocol
  (step I7 — constraint: authoritative or field-observed evidence + decision-maker sign-off +
  fixtures, never fixtures alone).

## 3. Repository constraints that shape every step

1. **TDD is red → green, literally.** For every step: write the failing test first, RUN it,
   confirm it fails **for the intended reason** (not a typo or import error); minimal
   implementation; run to green; refactor; full `bun test` before the step's commit. Fix the
   implementation, never the test — unless the test itself is proven wrong, stated in the
   commit. **One sanctioned exception — the characterization refactor** (used only where a
   step's whole claim is "no behavior change", today only step I3): capture the current
   implementation's output in a characterization test FIRST (it passes against the original —
   that is its point, and it commits with the original still in place), then refactor; the
   acceptance is the characterization plus the full suite green.
2. **The logVocab pin** (`scripts/logVocab.test.ts`, a TypeScript-AST scan, not a regex):
   any new JSONL event token fails the pin until declared. Declare, never loosen. This
   plan's one new token is specified exactly in step I6.
3. **The sole-spawn-site and no-nonliteral-dynamic-import scans** constrain how code and
   tests may be written, and **spelling the scanned tokens in comments trips them** — assert
   via AST helpers, and keep trigger tokens out of prose. The production diff adds **no
   process spawns** (batching is a GraphQL-shape change riding the existing `gh` lane); the
   probe runner uses the **existing bench gh seam** (`benchGh.ts`, the sanctioned bench
   spawn surface benchBoundary already rides) — no new launch site anywhere in `scripts/`.
   Corpus *construction* is an external operator procedure (§5 P2), never a committed
   script, precisely so no new spawn surface enters the repo.
4. **Test idiom**: scripted `GithubClient` fixtures + a real in-memory DB is the established
   discovery/orchestration idiom (see `orchestrate.test.ts`). Window and partition logic
   take injected capabilities (dispatch fn, solo-fetch fn, walker, clock, abort signal) so
   fixtures script envelopes and time without touching transport.
5. **Evidence discipline**: `docs/adrs/0001-*` and every benchmark artifact are append-only
   precedent — never edit them. Evidence tags are never deleted. Stage P's artifacts are
   split so pre-registration is itself immutable (§5 P2–P3): the frozen corpus, the raw
   try journal, and the result are three separate committed artifacts; a re-run is a NEW
   result artifact (`refs-probe-2.json`, …), never a rewrite.
6. **The ADR stays `proposed` until rvo ratifies.** Signed commits; conventional commit
   messages; push after each step's commit; never force-push a shared branch. PR-body
   accuracy is a reviewed surface in this repo — every body claim must match repo state at
   push time.
7. **Live identity**: any live GitHub spend runs as **`sondrateconsulting-ryan`** — confirm
   `gh api user --jq .login` before the first spend (never `gh auth login` against another
   keychain). Probe spend is real: the clean-baseline matrix is `850·p + 30` points
   (≈ 1,730 at p = 2) plus invalidation re-runs — pre-admitted per-tranche, never assumed
   trivial.

## 4. Module map

| Module | Change |
|---|---|
| `scripts/graphqlBatch.ts` (new, pure; **builder lands in Stage P**, partitioner in Stage I) | `buildBatchRefsQuery(repos, opts)`: aliased `rN: repository(owner:$oN, name:$nN)` selections, **variables-only binding** (2·B `-f` variables, no inline literals — `isCanonicalIdentity` admits GraphQL metacharacters, [github.ts:995-998](../../scripts/github.ts#L995)), each alias selecting `nameWithOwner` for identity re-assertion, `defaultBranchRef{name}`, `refs(refPrefix:"refs/heads/", first:100)` with the page-1 node shape the solo query uses; `opts.rateLimitRider` injects the probe's per-call `rateLimit { cost }` field and **nothing else** (a test pins that rider-on vs rider-off differ only by that field — the probe prices the query that ships, by construction). `partitionBatchEnvelope(envelope, expected)`: the ADR's steps 4–5 — whole-envelope validation before any per-alias outcome; per-alias routing only for path-rooted, all-errors-in-family `NOT_FOUND`/`FORBIDDEN`; identity re-assertion per alias (mismatch = batch-shape anomaly); everything else (pathless errors, unrecognized types incl. the resource-limit family, missing aliases, malformed shapes) = one anomaly verdict for the whole envelope. Pure data-in/data-out; no client, no clock. |
| `scripts/discoveryWindow.ts` (new) | The window manager: tumbling windows (disjoint, never refilled), **full snapshots before the window is served** (every window repository's continuation pagination completes, in kept order, before the first item is consumed — planned stops excepted), staging through consumption (**no per-repository side effect before the consuming repository's abort check**), age epochs (snapshot = retained attempt's dispatch; failure = its own occurrence), the age cap with the **staged-throttle exemption** (commits its mode's throttle mapping at any age — no mid-run re-queue), the head budget (resident heads, window-scoped), the continuation-time stop (dispatch-boundary trigger with worst-case pre-dispatch admission), the per-owner per-run downshift ladder (floor(B/2), floor 1), uniform degrade-and-downshift for every trigger on the ADR's exhaustive list, lazy fallback re-fetches, and abort checks before each batch and each continuation dispatch (in-flight calls drain; staged results discarded). Injected: batched dispatch fn, solo fetch fn, continuation walker, clock, abort signal. |
| `scripts/github.ts` | (a) `parseGraphqlEnvelope` extended to surface `errors[].path` and `type` (solo behavior byte-identical — pinned by existing tests); (b) `graphqlBatch(query, fields)`: sibling entry point sharing the graphql bucket lease and the classify-first order ([github.ts:848-851](../../scripts/github.ts#L848) precedent) — call-scope classification before envelope shape, batched dispositions per the ADR's step list (502/504 → degrade signal; other 5xx and the truncation shape → bounded transient retry, exhaustion → degrade signal; no-response → degrade signal), **cause-tagged exhaustion** with the any-throttle-evidence rule for mixed sequences, and *no* call-fatal 2xx-body behavior (the batched path returns classified outcomes; the window decides). Pre-envelope throws propagate to the caller (the window boundary catches; `ThrottleExhausted` keeps its type — the throttle door routes on it); (c) the continuation walker extracted from `listBranchHeads` (step I3) so solo and window paths share one battery. |
| `scripts/orchestrate.ts` | `processOwner` consumes discovery through the window when `batchSize ≥ 2`; at consumption a staged outcome becomes exactly its solo equivalent — snapshot → the existing planner path, failure → errors row, throttle → `requeue-throttle` ([orchestrate.ts:521-540](../../scripts/orchestrate.ts#L521)); `runPlan` rides the same seam with its own mappings (`discoveryErrors` + log line, [orchestrate.ts:1171-1177](../../scripts/orchestrate.ts#L1171)). At `batchSize: 1` the window module is **not constructed at all** — `discoverBranchHeads` is called exactly as today (the normative bypass, orchestration-level parity). |
| `scripts/config.ts` + `config.schema.json` | `discovery.batchSize`: integer, 1 to the probe-pinned default, default = the pin; values above the default rejected as unsupported. Config-hash treatment per the delegated decision (step I5). |
| `scripts/logVocab.test.ts` | The one new token of step I6 declared. |
| `scripts/benchRefsProbe.ts` (+ `.test.ts`) (new, Stage P) | The Confirmation-1 probe: rule executor + runner (§5 P1, P3), riding `benchGh.ts` for transport and the benchBoundary admission/washout precedents ([benchBoundary.ts:146-160](../../scripts/benchBoundary.ts#L146), [benchBoundary.ts:215-224](../../scripts/benchBoundary.ts#L215)); executable wiring mirrors the content-transport runner (`benchContentTransport.ts`'s entry shape). |
| Untouched | `db.ts` (no schema change), the §4 buckets/taxonomy/pause accounting, the content path (ADR-0001), report/export layers. EXPORTS.md documents the `export` CLI's column contract and no column changes — it correctly needs no edit (the T2c plan's §8 correction, re-checked here). |

## 5. Stage P — the probe PR (Confirmation check 1)

The probe **gates everything**, and pre-registration is structural: the rule executor, the
production query builder, the frozen corpus, and the ADR's artifact-path amendment are all
committed and reviewed **before any measured try**. A rule written after the data is not a
pre-registration.

* **P1 — builder + rule executor + runner (TDD; substantial → codex).**
  Build `buildBatchRefsQuery` first (pure, TDD — the probe must price the query that ships;
  the rider test of §4 pins probe-arm ≡ production-arm modulo the `rateLimit` field). Then
  the rule executor as pure functions over recorded tries: cell planning ({10, 25, 50}
  candidates × two strata, B = 1 control arms per cell, 5 paired interleaved tries), the
  cleanliness predicate (every dispatch produced exactly one §4-`ok` response; zero
  retries/degrades/fallbacks; no throttle, secondary, or resource-limit signal anywhere;
  every alias resolves and passes the full validation battery), frozen-vs-observed depth
  invalidation (2-re-run cap → `invalid` with cause), the 502/504 rule (try unclean + cell
  terminated + runner quarantined to the next reset epoch), the per-pair cost gate
  (candidate ÷ control ≤ ½, p = 1 stratum), the absolute gate (≤ 2 × `max(1, round(B/100))`
  points per batch, both strata), the page-1 wall gate (≤ 5 s, candidate arm), **both
  reducers exactly as the ADR states them** — page-1: per try, summed page-1 points ÷
  repositories covered; continuations: per try, summed continuation points ÷ pages
  observed; each cell reduces by the maximum over its clean tries — the header-delta
  cross-check (valid only within one reset window on an otherwise-quiet credential;
  recorded, cross-check only), the informational records (control/continuation/full-snapshot
  durations; the would-have-tripped-the-production-stop flag for tries whose continuation
  phase exceeds half the age cap), contiguous-prefix + cheapest-measured + smaller-B-ties
  selection, the non-monotone anomaly outcome, and the no-pass outcome. Admission
  arithmetic (per-try worst case × headroom × `1 +` remaining re-runs; `infeasible` when a
  tranche exceeds the bucket limit) and washout ride the benchBoundary precedents. The
  **runner contract** is part of this step: `bun scripts/benchRefsProbe.ts --corpus
  docs/adrs/0002-benchmark/refs-corpus.json --out docs/adrs/0002-benchmark/refs-probe.json`
  (wired like the content-transport runner), appending every physical try to
  `docs/adrs/0002-benchmark/refs-probe-journal.jsonl` as it runs (append-only; on restart
  the runner reloads the journal, re-derives cell state, and re-admits only the remainder —
  crash-safe resume with no double-spend), and writing the result artifact only at
  completion. Artifact schemas (corpus, journal row, result) are TypeScript types in the
  probe module, fixture-tested. Acceptance: every rule unit-tested with scripted try
  records (including: a control outlier tightens only its own pair; a no-response try is
  unclean by construction; an invalid cell blocks the prefix; B = 1 is never gated as a
  candidate); full suite green; `/codex review` on the diff clean of verified P1s.
* **P2 — corpus freeze + ADR artifact-path amendment (substantial → codex; needs rvo's
  one-line go-ahead for any repository creation).** Enumerate candidate corpora under the
  confirmed identity: the p = 1 stratum needs full same-owner batches of exactly B
  single-page repositories per tested B (synthetic shape: 2 branches each); the paginating
  stratum the same at > 100 heads (synthetic shape: 101 branches each). Where the live
  estate cannot furnish a full batch, construct a synthetic corpus under a designated test
  owner as an **external operator procedure** (documented verbatim in the corpus artifact's
  `provenance` field — `gh repo create` + pushing refs, run by the operator outside the
  repo; private visibility; names `refs-probe-p1-NN` / `refs-probe-p2-NN`; idempotent
  create-if-absent; retained until rvo authorizes deletion, since committed evidence must
  stay reproducible). **Repository creation is outward-facing state: get rvo's explicit
  go-ahead for the owner namespace and count before creating anything.** Cells whose
  stratum cannot furnish a full batch are committed `infeasible` — B = 50 is informational
  anyway; an infeasible B = 25 caps the ladder at B = 10 by the contiguous-prefix rule.
  Freeze the corpus (owners, repositories, per-repository observed page counts, provenance)
  as `refs-corpus.json` **before any measured try**; the frozen depths are the invalidation
  baseline and the admission input. In the same pre-registration commit, amend the ADR's
  one artifact-link sentence to the registered path (`0002-benchmark/` — evidence dirs stay
  per-ADR; the ADR's current sentence says "beside `boundary-probe.json`", and this
  amendment is prospective and reviewed, riding PR-P for rvo's ratification — never a
  retrospective blessing).
* **P3 — live run (operational; findings to the artifacts).** Confirm
  `gh api user --jq .login` = `sondrateconsulting-ryan`. Preflight `remaining`; execute the
  runner per-tranche with admission, quarantine, and washout; the journal accumulates
  per-try rows (points via each arm's `rateLimit { cost }`, header deltas, page counts,
  durations, cleanliness verdicts, flags); commit journal + result together when the run
  completes. A crash resumes from the journal; an abandoned run's partial journal is still
  committed (append-only honesty).
* **P4 — corrected arithmetic + outcome (substantial → codex).** Apply the ADR's own rule:
  measured values replace formula estimates everywhere they differ; the Worked-arithmetic
  floors recompute; the acceptance **presents** continuation-inclusive estate totals under
  the stated premises (both reducers, measured); the default ships only if every gate
  passes and the corrected 8 × 750 page-1 floor stays under 10% of a window — otherwise
  commit the no-pass or anomaly outcome verbatim and stop. The `discovery.batchSize`
  operator range's ceiling becomes the pinned default.
* **P5 — ratification ask (STOP).** Assemble the PR body (probe design, evidence, corrected
  arithmetic, selection outcome, the corpus provenance, and the ADR's ten-round REVISE
  disclosure restated honestly), run one `/codex review` over the whole PR diff, fix
  verified findings, then put the question to rvo: ratify Option 1 with the pinned default
  (the status-flip commit lands only on rvo's explicit word), or return the ADR. **Stage I
  starts only after PR-P merges.** If the probe returned no-pass/anomaly, this plan ends
  here by design.

## 6. Stage I — the implementation PR

Dependency order; every step is red → green TDD per §3.1; "codex" marks the substantial
steps (per-step `/codex review` scoped to that step's diff, verified findings fixed before
the next step begins); "mechanical" steps skip the outside voice.

* **I1 — envelope groundwork in `github.ts` (codex).** RED: tests for `errors[].path`/`type`
  surfaced through `parseGraphqlEnvelope` while every existing solo test stays untouched and
  green; **raw-response fixtures at the HTTP/envelope level** for the batched entry's whole
  classification table: pathless `RATE_LIMITED` → throttle (never anomaly);
  `RATE_LIMITED`/`RATE_LIMIT` with `x-ratelimit-remaining: 0` → primary, without →
  secondary (the PR #36 regression fixtures extended to batches, headers included);
  SSO-fatal on its 403/429 statuses; a permission-shaped 403, a redirect status, an
  unexpected 2xx shape, and a residual fatal status each classify to the step-3 fatal
  family (raw fixtures here — step I4's injected fakes must not be the only coverage);
  502/504 → degrade signal with no same-size retry; 500 → bounded transient retry,
  exhaustion → degrade signal; truncation shape (200 + unparseable + nonzero exit)
  likewise; no-response → degrade signal (deadline-kill included); **cause-tagged
  exhaustion** — throttle-then-transient and transient-then-throttle both throttle-tagged
  (any-throttle-evidence), all-transient transient-tagged. GREEN: the `graphqlBatch` entry +
  parser extension. Links: checks 2, 4.
* **I2 — `partitionBatchEnvelope` (codex).** RED first, from the ADR's fixture bill: a
  `NOT_FOUND` alias among B stages exactly one failure with siblings intact; a mixed
  envelope (family error + missing alias) commits nothing and is one anomaly; a
  swapped-identity envelope (alias rN carrying rM's `nameWithOwner`) is an anomaly; an
  alias-rooted resource-limit error (node-limit wording beside partial data) is an anomaly;
  an alias with multiple errors qualifies only if every one is in-family; a missing alias
  with no matching error is an anomaly and no empty snapshot is recorded. GREEN: the
  partitioner joins the Stage-P builder in `graphqlBatch.ts`. Links: checks 2, 3.
* **I3 — continuation-walker extraction (codex — it touches the validation battery;
  §3.1's characterization exception).** Capture characterization fixtures against the
  CURRENT `listBranchHeads` (scripted multi-page fixtures through the full battery —
  `MAX_PAGES`, per-page default re-assertion, duplicate/cursor guards,
  [github.ts:2344-2473](../../scripts/github.ts#L2344)) and commit them passing against
  the original; then extract the walker both the solo path and the window prefetcher call;
  the characterization and the whole suite stay green. Links: check 6 (one battery, shared
  by construction).
* **I4 — `discoveryWindow.ts` (codex; the biggest step).** RED from the ADR's window bill:
  kept-order consumption, never more than B ahead, tumbling (no refill); **every window
  repository's continuation pagination completes before the first item is consumed** (a
  fixture asserts no consumption precedes the continuation phase's end; planned stops
  excepted); **no per-repository side effect before consumption** at the module level;
  age epochs (retained-attempt dispatch for snapshots — internal retries advance it;
  own-occurrence for failures — the unfundable-pause case has no dispatch); age-cap discard
  → lazy per-repo re-fetch, with the **staged-throttle exemption** (commits its mode's
  throttle mapping at any age); head budget as resident count (discarded items release
  their heads), completes the in-flight repository, stops the window, resumes next window;
  the continuation-time stop (pre-dispatch worst-case admission against half the age cap;
  in-flight repository completes; one admitted call may still drain past the cap and its
  repository expires at consumption — fixture both); **three negative fixtures: age-cap
  expiry, head-budget stop, and continuation-time stop each fall back per-repo WITHOUT
  downshifting**; the downshift ladder (25 → 12 → 6 → 3 → 1, per-owner, per-run, reset at
  run start); **uniform degrade-and-downshift** for every trigger on the exhaustive list —
  envelope anomalies, 502/504, no-response, 5xx and truncation exhaustion, step-3 fatals,
  and every non-throttle pipeline throw (output-cap / stream / spawn / invariant fakes: a
  batch-only invariant's solo re-fetches *succeed*; a shared fault reproduces the per-repo
  errors row) — with `ThrottleExhausted` precedence (throttle door: whole-window
  `requeue-throttle` from the batched call; repository-local in the continuation phase) and
  continuation-phase locality (no downshift); sibling pause propagation (a long-horizon
  continuation throttle or terminal transient backoff leaves later siblings waiting the
  same bucket horizon, exhausting into their own repository-local outcomes);
  degraded-then-solo-success leaves no permanent rows; abort checks at batch and
  continuation dispatch boundaries, in-flight drains, staged results discarded. Links:
  checks 2 (commit-at-consumption halves), 4, 5.
* **I5 — config surface + the config-hash delegation (codex).** Ordered BEFORE the
  orchestration wiring so step I6 has a real `Config` field to consume. Survey how existing
  operational-only keys are excluded from the hash projection
  ([config.ts:84](../../scripts/config.ts#L84),
  [config.ts:176](../../scripts/config.ts#L176), the projection at
  [config.ts:415-546](../../scripts/config.ts#L415)); decide `discovery.batchSize`'s
  treatment against that precedent under the recorded constraint — **changing batchSize must
  not perturb the §3 skip predicate or orphan resumable work** (exclusion from the hash
  projection is the expected answer; if the survey contradicts that, record why and take
  the deviation to rvo with the I-stage PR). RED: schema/validation tests (integer, 1..pin,
  above-pin rejected, default = pin) + a hash-stability test (two configs differing only in
  batchSize produce the same `config_hash`). Document the decision at the decision site and
  in the §5.B amendment. Links: check 7.
* **I6 — orchestrate + `--plan` integration + telemetry (codex).** RED: consumption-time
  mapping tests (staged snapshot → planner path; staged failure → errors row at
  consumption; staged throttle → `requeue-throttle`; in `--plan` the same staged outcomes →
  `discoveryErrors` + log line, never a permanent-failure label); **an orchestration-level
  abandoned-window fixture** — scripted client + real in-memory DB + captured JSONL and
  progress taps assert zero per-repository rows and zero per-repository events before
  consumption (the pure module's structural absence is not this test); **a cache-abstinence
  test** — the batched path performs no cache reads or writes (scripted client counts
  cache calls; the never-cached property, check 6); **B = 1 parity at the orchestration
  level** — same call sequence, same events, same abort boundaries as today, asserted at
  both the client-call and orchestration level (the window module never constructed); the
  run `Aborter` stops batch/continuation dispatch at the new boundaries. **Telemetry,
  specified exactly**: one new JSONL event token `discovery-window`, fields `event:
  "discovery-window"`, `action: "dispatch" | "degrade" | "downshift" | "stop" | "requeue"`,
  `org`, `batchSize`, `cause` (string), and counters — window-scoped, carrying **no
  repository name** for staged items (per-repository events fire only at consumption,
  through today's shapes); declared in the logVocab pin. GREEN: wire
  `processOwner`/`runPlan`. Links: checks 4, 5, 6.
* **I7 — the family-extension protocol (mechanical; the second named delegation).** The
  closed family ships closed. Record the extension protocol verbatim where implementers
  will meet it — a comment at the family site in `graphqlBatch.ts` and a paragraph in the
  §5.B amendment: *extending the per-alias family requires authoritative or field-observed
  evidence that the type is repository-scoped, decision-maker sign-off, and fixtures — not
  fixtures alone.* Acceptance: both sites grep-verifiable; no code path admits a type
  outside the family.
* **I8 — PROMPT.md §5.B amendment + spec bill (codex — the handoff names it substantial).**
  Amend §5.B to describe batched page-1 discovery: the variable-binding rule, identity
  re-assertion, classify → stage → partition with the one-door rule, cause-tagged exhaustion
  (any-throttle-evidence), window bounds (epochs, age cap + throttle exemption + mode
  mappings, head budget, continuation-time stop), downshift triggers, `discovery.batchSize`
  (validation, default, monotonicity note, config-hash treatment), and the B = 1 bypass.
  Re-check §4's AS-BUILT note against the batched path's disclosed deltas. README event
  table for the new token. Write every gate-dependent sentence in a form true both before
  and after rvo's merge (the Step-D lesson). Links: check 7.
* **I9 — suite, scans, coverage (mechanical).** Full `bun test` + `tsc --noEmit` clean;
  logVocab pin green with the declared token; spawn-site count unchanged; new-module
  coverage ≥ 80%; no scan-tripping tokens in comments or fixtures; the never-cached grep
  ([github.ts:2195](../../scripts/github.ts#L2195)) still true.
* **I10 — final gate: `/santa-loop` at a 7-round ceiling, then rvo.** §8.3 has the
  invocation contract. After the loop closes (converged or capped) and any post-loop fixes
  land, **re-run the complete I9 gate on the exact final tree** — the PR body's suite claim
  cites that final run, never an earlier one. Then sync the PR body to the loop's true
  outcome and request rvo's merge review.

## 7. Confirmation-check ownership

| ADR check | Owned by |
|---|---|
| 1 — live probe, pre-registered rule (incl. header-delta cross-check, informational durations, the would-have-stopped flag) | Stage P (P1–P4) |
| 2 — scripted-envelope classify/stage/partition fixtures | I1 (classification, raw fixtures), I2 (partition), I4/I6 (commit-at-consumption) |
| 3 — partial-response fail-closed | I2 |
| 4 — degrade, downshift, containment (incl. the three no-downshift planned bounds) | I1 (call dispositions), I4 (window), I6 (mappings) |
| 5 — window bounds and lifecycle | I4, I6 (orchestration-level abandoned-window fixture) |
| 6 — snapshot invariants unchanged + never-cached | I3 (one battery), I6 (batched-path battery run + cache-abstinence test), I9 (grep) |
| 7 — spec and surface bill | I5 (config), I7 (protocol), I8 (PROMPT/README), I9 (logVocab) |

## 8. Process machinery

### 8.1 The codex outside voice

Substantial steps (P1, P2, P4, P5, I1–I6, I8) each end with `/codex review` scoped to that
step's diff, in a **fresh codex session per step** (the ADR-review thread
`019fd023-7e70-7710-b1e4-d85784e40178` is that loop's record — do not reuse it for
implementation review). Verified findings are fixed before the next step begins; refuted
findings are recorded with their refutation (a refutation is a claim to check like any
confirmation). Mechanical steps (I7, I9) skip it. Operational notes, hard-won: the skill's
timeout wrapper cuts `ultra` off mid-analysis routinely — recover by resuming with
"Interrupted before emitting. Finish in-flight checks and emit your numbered [P1]/[P2]
findings NOW, ending with the single VERDICT line. No new broad re-reads."; parse the
`--json` stream; in zsh use `${pipestatus[1]}`; write scratch files under the session
scratchpad (system-temp `mktemp` is sandbox-blocked).

### 8.2 TDD protocol per step

RED (run it; confirm the failure is the intended one) → GREEN (minimal) → refactor → full
`bun test` → conventional commit → push. One step, one commit minimum; never batch steps
into one commit. The single sanctioned exception is §3.1's characterization refactor (step
I3). If a RED cannot be written for a claim anywhere else, say so in the step's commit
rather than writing a vacuous test.

### 8.3 The final santa-loop, 7-round ceiling

Invoke `/santa-loop` over the PR-I diff with the ceiling override stated in the invocation
arguments (the command's default cap is 3 and it exposes no parameter, so the instruction
IS the override): *"Round ceiling for this loop: 7 (explicit override of the default 3).
Convergence rule unchanged — all three reviewers NICE."* The triple is Opus 4.6 @ xhigh +
GPT-5.5 @ xhigh + gpt-5.6-sol @ ultra. Keep reviewer packets lean — ultra times out on big
packets; scope by diff, not by pasted file bodies. **Reviewer isolation is mandatory: never
`git add` or commit while a reviewer agent is live, and verify `HEAD` matches the reviewed
tree before any push** — a reviewer's mutation test once got committed in this repo. Santa
loops here have historically not converged in 3 rounds; if 7 rounds do not converge, record
capped-not-converged with each reviewer's standing positions, fix verified findings
post-cap with the disclosure pattern the ADR's own loop used, and escalate to rvo. Never
report a NICE that did not happen.

### 8.4 Escalation and stops

Hard stops: rvo's corpus go-ahead (P2), the probe's no-pass/anomaly outcomes (P4), the
ratification gate (P5, and PR-P's merge as PR-I's base condition), a santa-loop cap
(I10 → rvo), and any discovered conflict between this plan and the ADR (the ADR wins; if
the ADR itself is wrong, that is a recorded finding for rvo, not a silent patch).

## 9. Disclosed behavior changes (PR-I body material)

1. The discovery-to-scan window widens as the ADR states: within a window, decisions ride a
   snapshot up to B-repositories-of-processing (≤ age cap) old — skip-as-current,
   policy/cutoff/cap classification, newly-created branches, and staged failures that
   commit after their cause cleared, all self-healing at the next run's live re-discovery;
   the clone path still fails loud on movement.
2. Batched 502/504 and no-response reroute from transient retry to degrade-and-downshift;
   throttle-caused window exhaustion becomes a window-scoped `requeue-throttle`
   (`discoveryErrors` in `--plan`); pre-envelope throws are caught at the window boundary
   (the solo path's per-repository catch, reproduced through lazy solo re-fetch). Disclosed
   deltas, not taxonomy changes; §4 buckets and pause accounting untouched.
3. Fallback paths add bounded re-spend (degrade: up to the window's full per-repo
   pagination; head-budget/time stops: ≤ B − 1 duplicated page-1 points; age-cap: a
   window's completed continuations) — nominal no-retry logical bounds.
4. `batchSize: 1` reproduces today's behavior exactly (orchestration-level parity, tested);
   it is the escape hatch the drivers promise.
5. New config key `discovery.batchSize` (excluded from `config_hash` per I5's decision —
   resumable work survives tuning); one new JSONL event token (`discovery-window`); no DB
   schema change; no report/export change.

## 10. Doc sweep (rides I8/I9; verified in the santa packet)

PROMPT.md §5.B (the amendment) and §4 AS-BUILT note; README's discovery/rate-limit
paragraphs and event table; config.schema.json descriptions. The ADR's artifact link moves
in Stage P (P2), not here. EXPORTS.md needs no edit (no export-column change — checked, not
assumed).

## 11. Kickoff checklist for the implementation session

1. Read this plan top to bottom, then the ADR's "The design, concretely" + Confirmation
   checks end to end. The ADR wins conflicts.
2. Confirm PR #38's fate (merged → branch off `main`; open → stack on its branch).
3. Confirm identity (`gh api user --jq .login` = `sondrateconsulting-ryan`) before any live
   spend; `bun test` green before starting.
4. Execute Stage P (P1 → P5), including rvo's corpus go-ahead at P2. Stop at the
   ratification gate; PR-I branches only after PR-P merges.
5. After PR-P merges: Stage I (I1 → I10) in order, TDD + codex per §8, santa-loop(7), rvo.
6. Fill §12 as loops complete — verdicts, counts, refutations, post-cap disclosures —
   matching the voice of the ADR's Review history and the T2c plan's §9.

## 12. Review-process ledger

- **Plan codex review, round 1 (gpt-5.6-sol @ ultra, the ADR-review thread, 2026-08-05):
  REVISE — 16 P1, 3 P2; every finding verified and applied before this plan's first
  commit.** Headlines: the probe's artifact-path deviation became a prospective,
  reviewed ADR amendment riding PR-P's pre-registration commit (not a retrospective
  blessing); the continuation reducer was misstated (÷ repositories → ÷ pages observed, per
  the ADR); `buildBatchRefsQuery` moved into Stage P with a rider-equivalence test so the
  probe prices the query that ships; the runner gained its executable contract (CLI, three
  append-only artifacts — corpus / journal / result — and journal-resume semantics);
  corpus construction became an explicitly external, rvo-gated operator procedure with both
  strata specified (the spawn scans forbid a committed setup script); step I3's TDD
  contradiction became the sanctioned characterization-refactor exception; the old I5/I6
  ordering was inverted (config before orchestration — the wiring needs the field);
  raw-response fixtures for the step-3 fatal families moved into I1; the three
  no-downshift planned-bound fixtures were added to I4; the never-cached check gained
  owners (I6 cache-abstinence test + I9 grep); the telemetry surface was specified exactly
  (one token, `discovery-window`, window-scoped, no repository attribution pre-consumption);
  I10 now re-runs the full gate on the exact final tree after any post-santa fixes; an
  orchestration-level abandoned-window fixture (real DB + captured taps) joined I6; PR-P's
  *merge* became PR-I's explicit base condition; and this ledger entry itself was the
  review's final requirement.
- **P1 codex review (gpt-5.6-sol @ ultra, fresh session `019fd11b-0e83-7ae3-ad39-ec9deb1b0981`,
  2026-08-05): FAIL — 5 P1 + 6 P2; every finding verified, none refuted; all 11 fixed before
  P2 began** (commit `1b917cc`). The run hit the skill's timeout mid-analysis and was resumed
  with the §8.1 recovery message, which produced the full numbered findings. Headlines: the
  drift rule could be satisfied by a walk aborted mid-continuation (fabricated drift buying an
  invalidation re-run for a gate-deciding candidate failure) — fixed with a `stoppedBy`
  provenance field so only positive evidence (complete-at-wrong-depth, stopped-at-frozen-bound)
  invalidates; the quarantine obligation journaled only after its sleep (a crash mid-sleep
  would resume past it) — now written before, and resume honors any unexpired horizon; a crash
  mid-try left its spend invisible — a `try-start` intent row now precedes every first
  dispatch; nonzero-exit ok-shaped envelopes were clean — now unclean per the
  truncated-transfer precedent; concurrent runners could interleave one journal — a
  single-writer lock plus exclusive result creation; plus a journal header binding corpus
  sha256 + constants fingerprint on resume, tail tolerance narrowed to syntactic tears,
  header deltas made cost-inclusive and single-epoch-only, p2 stratum head-count enforcement,
  same-owner batch enforcement in the builder, and the page-1 shape test re-derived from the
  source-pinned solo document. One process disclosure, recorded in the runner slice's commit
  (`1164c93`): that slice's implementation was drafted before its tests; the RED run was taken
  against a stubbed runner (12 failures for the intended reason) and the implementation
  restored to green — the failing run is real; the draft order was not test-first.
- **P2 corpus + rvo gate (2026-08-05): the live estate could not furnish any full batch**
  (largest owner: 9 repositories; nothing over 100 branches), so the synthetic corpus was
  constructed per the plan — after rvo's explicit go-ahead, asked and answered before any
  creation: **owner namespace = the `sondrateconsulting` organization; full matrix, 100
  repositories** (50 × p1 at 2 heads, 50 × p2 at 101 heads; private; retained until rvo
  authorizes deletion). Construction and the REST observation pass are recorded verbatim in
  the corpus provenance. Freeze commit `c3a13ce` (corpus + the prospective ADR artifact-path
  amendment, one commit, before any measured try).
- **P2 codex review (gpt-5.6-sol @ ultra, fresh session `019fd340-f458-7780-9aed-973b4cd3c423`,
  2026-08-05): FAIL — 1 P1 + 1 P2, both verified, both fixed before P3** (commit `ad17cb1`):
  the placeholder midnight `frozenAtIso` backdated the freeze (now the true post-observation
  instant), and the provenance paraphrased the procedure (now the commands verbatim, both
  strata, including the discarded email-privacy-rejected first template pair).
- **P3 live run (2026-08-05, `sondrateconsulting-ryan`): DEFAULT PINNED B = 25** — 26 try
  rows (25 completed pairs + 1 candidate-only attempt), 976 dispatches, 975 measured
  points; both candidates 10/10 clean; every cost-readable batch priced at exactly 1 point
  (formula confirmed; the 2× tolerance never consumed); the informational B = 50 paginating
  cell drew an HTTP 504 on its first 50-alias batch → cell terminated + the runner's
  1,400 s quarantine to the reset epoch fired exactly as pre-registered; journal + result
  committed together (`2f61245`). The 504 is live corroboration of the ADR's timeout
  caution at a shape the operator range never reaches.
- **P4 measured-outcome record + codex review (fresh session
  `019fd36d-8983-7480-a099-e4e0380fa17b`, 2026-08-05): FAIL — 3 P2, all verified against
  the journal, all fixed** (`bfc1d38` + `69a073f`): the every-call cost claim scoped to
  cost-readable calls (the 504 returned no rider; its penalty deducts unobserved); the
  header-delta cross-check recorded as noisy and non-corroborating (16/50 clean arm deltas
  above their rider sums, worst +4 — quiet-credential premise did not hold; gates ride the
  rider alone, as pre-registered); '26 paired tries' corrected to 25 pairs + 1
  candidate-only attempt (the P3 commit message carries the same overcount, immutably —
  the ADR text is the authoritative record).
- **P5 whole-PR codex review (fresh session `019fd375-03d6-7323-b525-cebf5e1c5153`,
  2026-08-05): FAIL — 1 P1 + 5 P2, all verified, all fixed** (`32ee05f` + the PR body). The
  P1: the quarantine obligation became durable only at the post-try row append — a crash
  between the 504 observation and that write would have resumed into the penalized window;
  the row now journals AT OBSERVATION, before even its try row (order-pinned by test). The
  P2s: the journal header's binding gained the bench-config file sha256 with its scope
  stated exactly (legacy pre-binding headers — the committed Stage-P journal is one — stay
  parseable forever but refuse resume), and four PR-body accuracy corrections (wall claim
  scoped to clean calls — the 504'd batch ran 11.7 s; resume claim scoped to completed
  tries with whole-try replay disclosed; the two ADR changes described as they are; the
  append-only claim scoped, disclosing the one pre-measurement corpus remediation). This
  run also hit the timeout wrapper mid-analysis and was recovered by the §8.1 resume
  message, like P1's.
- **Ratification (2026-08-05): rvo ratified Option 1 with the pinned default B = 25** at the
  Stage-P gate — the question was put with CI green on PR #40 and the ten-round REVISE
  disclosure restated; the answer was "Ratify — accept @ B = 25". The `proposed → accepted`
  flip landed on the PR-P branch on that explicit word, with both gate-dependent ADR
  sentences reconciled to the post-gate truth. Stage I remains gated on PR-P's MERGE (the
  evidence, corrected ADR, pinned default, and accepted status must all be on `main`).
- **Restack (2026-08-08, rvo):** after PR #38 squash-merged to `main` (`0d7760f`, which also
  removed the spent continuation handoff), rvo force-updated the PR-P branch, replaying the
  Stage-P commits onto the new `main` — content-identical diffs under new hashes. The commit
  hashes cited in the entries above were rewritten to the surviving replays in the same
  sweep; the original hashes live only in this ledger's own history now.
- *(the implementation session appends per-step codex outcomes, the santa-loop record, and
  any live-run observations here, exactly as `adr-0001-t2c-implementation.md` §9 did.)*
