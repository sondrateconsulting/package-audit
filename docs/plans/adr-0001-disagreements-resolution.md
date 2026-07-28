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
   pre-registered eligibility-and-margin decision rule. The ADR's acceptance flow becomes: harness
   lands → run happens → committed report → status flips (or the outcome is rewritten). Dates and
   deliverables in §6.
2. **D2 resolves** by defining **Option 2c** (§3), adding it to ADR-0001's Considered Options with
   a full pros/cons section, reworking the Decision Outcome so the case for Option 1 no longer
   leans on a byte-fidelity argument that 2c defeats, and adding 2c as benchmark driver T2c.

Both resolutions preserve the ADR's honest posture: the recommendation stays provisional, and the
recorded disagreements stay in the Review history — annotated with how each was closed, not erased.

## 3. Option 2c — per-unit clone, no checkout, canonical-object reads

### 3.1 Definition

For each branch unit on the default (non-truncated) path:

1. `git clone --depth 1 --single-branch --no-tags --no-recurse-submodules --no-checkout
   --template= <url> <dir>` — the production argv plus `--no-checkout`. No working tree is ever
   materialised, so `.gitattributes` (`eol`, `ident`, `working-tree-encoding`) never runs.
2. Head coherence: `git rev-parse HEAD` (already allowlisted,
   [readOnlyGuard.ts:236](../../scripts/readOnlyGuard.ts#L236)) must equal the discovery-pinned
   OID, else fail closed — the same force-push guard Option 2a needs.
3. Enumeration: `git ls-tree -r -z -l --full-tree HEAD` replaces the per-unit REST tree request
   entirely — mode, type, OID, *canonical object size*, and path for every entry, with no
   100,000-entry / 7 MB truncation cliff.
4. Content: `git --no-replace-objects cat-file --batch` reading validated `^[0-9a-f]{40}$` OIDs on
   stdin, returning length-prefixed raw object bytes.

Symlinks (mode `120000`), routed by the ls-tree mode exactly as Option 1 routes by validated tree
mode, go to the same REST `fetchFileRaw` fallback to preserve today's dereferenced-bytes findings.
Binary blobs need no fallback at all — `cat-file` returns raw bytes natively, which is *better*
than Option 1's lossy UTF-8 fallback path. The 2 MiB gate reads ls-tree's object sizes, which are
canonical and platform-independent — fixing 2a's transformed-`lstat`-size problem.

### 3.2 What 2c neutralises, what it inherits, what it adds

**Neutralised (the arguments that decided against 2a):**

- *Byte fidelity*: reads are the committed objects themselves. Self-verifying the same way Option 1
  is — hash the `blob <len>\0<body>` frame against the ls-tree OID.
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

- Two new `readOnlyGuard` verbs with exact-argv grammars: `ls-tree` (fixed tuple) and `cat-file`
  (fixed tuple, `--textconv`/`--filters` structurally absent, not merely denied), plus
  `--no-checkout` added to the clone boolean allowlist
  ([readOnlyGuard.ts:218](../../scripts/readOnlyGuard.ts#L218)). The guard's comment currently
  excludes `cat-file` by name ([readOnlyGuard.ts:206](../../scripts/readOnlyGuard.ts#L206)); ADR-0001
  already concedes this is a cost, not an impossibility.
- A stdin protocol the guard cannot see: `assertReadOnlyGit` validates argv, but `--batch` reads
  object names from stdin, and git resolves arbitrary revs there. Containment moves to the caller:
  a writer that emits only regex-validated 40-hex OIDs, tested exhaustively. This is a genuinely
  new trust boundary, and it is 2c's weakest point.
- Binary spawn framing: the production spawn is `stdin: "ignore"` and decodes stdout as UTF-8
  ([github.ts:168](../../scripts/github.ts#L168),
  [github.ts:180](../../scripts/github.ts#L180)) — lossy for exactly the bytes `--batch` exists to
  deliver. 2c needs a second spawn seam: stdin piping plus incremental length-prefixed binary
  reads with the byte cap enforced per frame.
- Path encoding: `ls-tree -z` emits raw path bytes; a non-UTF-8 path mangled by the UTF-8 decode
  must fail closed, not silently mismatch.

### 3.3 Evaluation stance

2c is the strongest challenger to Option 1, and the two are near-mirror images: Option 1 buys
in-process purity at the price of a batching seam, an API-wide admission scheduler, and
partial-failure handling; 2c buys zero-REST content *and* tree acquisition at the price of two
guard verbs, a stdin trust boundary, binary framing, and disk-on-every-unit. Neither ledger can be
settled by argument — which is precisely why D1's benchmark exists. The ADR's provisional
recommendation (Option 1) stands on one defensible asymmetry: its new surface is in-process and
exercisable by the existing injected-spawn tests, while 2c's surface includes a subprocess protocol
boundary. That asymmetry is worth a margin, not a veto — §4.7 prices it.

## 4. The option-selecting benchmark, specified

### 4.1 Harness

`scripts/benchContentTransport.ts` (flat, matching repo convention), run as
`bun run bench:content`. Standalone: it reuses production modules where realism demands
(selection logic, throttle classification, GraphQL query construction) but never touches the
production database or temp prefix. Not in CI — it needs live network and burns real budget; its
pure planning functions (batch packing, corpus validation, frame parser) get ordinary unit tests
that do run in CI. Results land in `docs/adrs/0001-benchmark/` as committed artifacts:
`corpus.json`, per-repo `selected/*.json`, `runs.jsonl`, `report.md`.

### 4.2 Corpus

Six slots. Candidates are named now; final pinning (owner/repo @ 40-hex SHA) happens in the harness
PR, with each slot's qualifying property *verified at pinning time* and recorded in `corpus.json`.
A candidate that fails verification is swapped, not forced.

| Slot | Purpose | Candidate(s) | Pinning verification |
|---|---|---|---|
| C1 | Multi-branch tree sharing | `fastify/fastify` (main + released lines) | ≥3 branches; ≥80% shared tree OIDs between two of them |
| C2 | Mid-size typical service repo | `nodejs/undici` | 1k–3k files; JS/TS manifests present |
| C3 | Path-heavy tree | `NixOS/nixpkgs` | recursive-tree payload dominated by path bytes; deep nesting |
| C4 | Truncated tree | `llvm/llvm-project`, else `chromium/chromium` | REST recursive tree returns `truncated: true` at the pinned SHA |
| C5 | Checkout-transforming `.gitattributes` | `PowerShell/PowerShell`, else a `dotnet/*` repo | ≥1 selected file whose checkout bytes ≠ blob bytes under `core.autocrlf=true` |
| C6 | Symlink fidelity (fixture, not perf) | `nodejs/node` @ `b2a024b1…` (M9), plus a small clone-feasible repo with mode-`120000` entries (candidate: `git/git`) | tree lists a mode-`120000` entry among selected paths |

C1–C5 form the **performance corpus** (repeated timed runs). C6 is a **fidelity fixture**: checked
on every driver, but not repeatedly timed — `nodejs/node` is too heavy to cold-clone K times for
no additional information. C4 is exempt from driver T1's timed matrix on its *whole* tree only
where the production design would itself route to clone (Option 1 retains the clone fallback for
truncated trees — the benchmark must measure the design, not an idealised version of it).

Per-repo selected sets are capped at ≈400 files (§4.8 budget math). If a slot's natural selection
exceeds the cap, the pinning step takes a deterministic prefix (sorted paths, seeded) and records
it — every driver consumes the identical set.

### 4.3 Workload pinning and ground truth

At pinning time, once per corpus repo:

1. Run the production selection logic (manifest location → lockfile election → source/CLI gates)
   against the pinned SHA via the status-quo path, recording the final selected set: `{path, mode,
   blobOid, size, class}` per entry.
2. Record ground truth per entry: sha256 of the canonical blob bytes (from a local full clone at
   pinning time — pinning is not a measured activity, so its tooling is unconstrained), plus, for
   mode-`120000` entries, sha256 of the REST dereferenced bytes (the declared fallback expectation,
   deterministic because the target is pinned by the same commit).
3. Record the expected *route* per entry per driver (primary | symlink-fallback | binary-native |
   truncated-fallback), so fidelity failures are attributable.

### 4.4 Drivers

| Driver | Option | Shape |
|---|---|---|
| T0 | Status quo | REST `contents` per file, production Accept header, production concurrency semantics, production throttle classification |
| T1 | Option 1 | Aliased GraphQL blob batches under the ADR's admission caps; two-round dispatch (manifests+CLI, then sources+lockfiles) exactly as the production design forces; per-alias hash validation; symlink/binary/truncated → REST fallback, counted |
| T2a | Option 2a | Production `cloneShallow` argv + checkout + `walkClone` + filesystem reads |
| T2c | Option 2c | §3.1 exactly: `--no-checkout` clone, `rev-parse` coherence, `ls-tree -r -z -l`, `cat-file --batch` with framed binary reads |

Driver argv discipline: each clone driver must use exactly the argv its option's production design
specifies — for T2c that includes the *proposed* guard grammars, which ship in the harness PR as a
standalone module the bench asserts every spawn against (production `readOnlyGuard` is untouched
until an ADR chooses 2c).

**Option 3 is not a driver.** It is evaluated the way the ADR already recommends: an offline
duplicate-OID analysis over the corpus trees (cheap, no network), reported alongside — plus one
warm-run scenario (advance C1 one commit, re-run the winning driver with and without OID keying)
to quantify what Option 3 would add *compositionally*.

**T1 cap sweep.** Before the timed matrix, a one-repo sweep over alias counts
{100, 200, 250, 300, 400} (3 reps each) fixes T1's production alias cap: the largest count whose
p95 batch wall time ≤ 8.0 s (client-observed, 2 s under GitHub's 10 s processing cutoff) with zero
5xx. The sweep also probes M4: step +25 aliases from the chosen cap until first failure, 3 tries at
the failure point, to establish whether the 462-alias 502 is deterministic. Sweep results feed the
ADR's admission-cap requirement with measured numbers.

### 4.5 Protocol

- **K = 5** repetitions per (performance-corpus repo × driver). A *run* is: fresh temp dir (bench
  prefix `pkg-audit-bench-*`, distinct from production's `pkg-audit-*` so the production sweep can
  never reap it and vice versa), empty cache DB, resolve every workload entry, tear down.
- **Interleaving:** within each repetition index, drivers run round-robin (T0, T1, T2a, T2c, next
  repetition…) so slow drift in network or API weather decorrelates from driver identity.
- **Cold** means: no `api_cache` rows, no reused clones, no HTTP cache. DNS/TLS warmth is accepted
  as ambient (a per-run `HEAD` request to api.github.com warms both equally for API drivers; git's
  transport warms itself).
- **T2a determinism probe:** T2a runs its K reps under `core.autocrlf=false` and one additional rep
  under `core.autocrlf=true`; any byte divergence between the two on the same entry is recorded as
  a G1 determinism failure (§4.7) with the diff attributed to C5's `.gitattributes`.
- Each run records rate-limit headroom before/after from `rate_limit` (both `core` and `graphql`
  buckets), and every response's secondary-limit signals (429s, `retry-after`).

### 4.6 Metrics, per run

1. Wall time (workload start → last entry resolved).
2. HTTP requests by class: REST content, REST tree, REST fallback, GraphQL requests; GraphQL
   points as the *measured* `rateLimit { cost }` sum, never the formula.
3. Git subprocess count and transferred bytes (`git count-objects -v` pack size after clone; body
   bytes summed for HTTP drivers).
4. Peak disk under the run's temp dir.
5. Failures: 5xx, timeouts, retries (attempt-counted), fallback count by cause (symlink, binary,
   truncated, batch-error), incomplete entries.
6. Fidelity: every delivered entry's bytes hashed and compared to the §4.3 ground truth for its
   declared route.

Aggregation: p50/p95 across the K reps, per repo per driver, plus the derived headline metric:

> **Estate throughput** — selected files resolvable per hour, `min(bucket ceiling, wall
> throughput)` where bucket ceiling = `5000 × files ÷ units` per applicable bucket (REST requests
> against `core`; GraphQL points against `graphql` — separate buckets, so the binding one governs)
> and wall throughput = `3600 × files ÷ p50 seconds`. Tree acquisition counts toward units (T0/T1
> pay it, T2a/T2c do not); discovery (repo/branch listing) is excluded as identical across drivers.
> Reported per bucket size, so 15,000-point credentials can be read off the same data.

### 4.7 Pre-registered decision rule

**Eligibility gates, per driver (all must hold):**

- **G1 Determinism/fidelity:** delivered bytes for every entry are a pure function of
  `(commit, path, declared route)` — byte-equal to ground truth in all reps, and invariant across
  the T2a gitconfig probe. A driver whose policy cannot state expected bytes machine-independently
  fails G1 *by construction*; the measured divergence is the evidence.
- **G2 Completeness:** every workload entry resolves via its declared route; a whole-batch failure
  surfacing as silent per-entry absence is a G2 failure, not a fallback.
- **G3 Stability:** ≥ K−1 of K reps complete without unrecovered failure; retry storms capped by
  the production attempt limit.
- **G4 Envelope:** peak disk ≤ 2 GiB per unit (ratifiable constant); zero observed
  secondary-limit violations (any 429/secondary event = automatic review, not silent tolerance).

**Selection among eligible drivers:**

- Headline comparison: geometric mean of estate throughput across the performance corpus.
- **The incumbent-displacement margin: a challenger displaces Option 1 iff its geo-mean throughput
  ≥ 2.0× Option 1's *and* it is ≥ 1.0× on every individual corpus repo (no class regression).**
  The 2× prices Option 1's unbenchmarkable design advantage — in-process surface, no new guard
  verbs, no stdin trust boundary, no disk on the common path. It is a deliberately high bar:
  crossing it means the performance story is not arguable.
- If Option 1 itself fails a gate, the margin evaporates: the best eligible driver wins outright.
- If no driver is eligible, or the margin is not crossed but Option 1 trails, the ADR stays
  `proposed` and the result escalates to the decision-maker with the data — the rule decides the
  clear cases and refuses to launder the unclear ones.

**Outcome mapping:** Option 1 confirmed → ADR status `proposed → accepted`, benchmark report linked
as decision evidence. Challenger crosses the margin → ADR Decision Outcome rewritten for the
winner *before* any acceptance (MADR permits revising a `proposed` ADR in place; the Review history
records the reversal). Escalation → explicit decision-maker call, recorded in the ADR.

### 4.8 Budget and safety

- Estimated API spend per full matrix: T0 dominates at ≈ Σ selected ≈ 1,600 REST requests × 5 reps
  = 8,000 requests ≈ 1.6 bucket-hours; T1 ≈ tens of points plus fallbacks; T2a/T2c ≈ fallbacks
  only. The harness is **bucket-aware and resumable**: it checks `rate_limit` before each run,
  sleeps to reset when projected spend exceeds headroom × 1.5 safety factor, and persists partial
  results — a matrix may span hours without invalidating per-run measurements (sleeps happen
  *between* runs, never inside one).
- Git pacing: well under 15 ops/s/repo by construction (≤ a handful of subprocesses per run);
  stated so the report can assert it.
- The bench must run against github.com with an ordinary PAT and no org-internal repos — everything
  in the corpus is public, so the artifacts are reproducible by anyone.

## 5. ADR-0001 edits (applied in this PR once this plan converges)

1. **Considered Options:** add Option 2c.
2. **New pros/cons section** for Option 2c carrying §3's ledger — neutralised objections, inherited
   costs, new surface — with code links.
3. **Decision Outcome:** rework the paragraph that stacks the `cat-file` cost onto "the disk,
   sweep, symlink, and routing problems" to decide against "the clone options" collectively — 2c
   dissolves the symlink and routing members of that list and pays the `cat-file` cost to dissolve
   the byte-fidelity one, so the argument must be re-scoped to 2a and the case for Option 1 over 2c
   restated as §3.3's surface asymmetry plus the benchmark margin. Name 2c the strongest
   challenger, explicitly benchmark-gated.
4. **Confirmation:** replace the four-line gate sketch with a summary of §4 and a link to this
   plan: corpus slots, drivers (2c included; Option 3 restructured to the compositional analysis),
   the eligibility gates, the declared 2× margin, and the outcome mapping. The "predeclared margin"
   promise becomes an actual number.
5. **Review history:** append the resolution of both disagreements — D1 closed by the executable
   benchmark spec with a pre-registered rule; D2 closed by in-ADR evaluation of Option 2c and its
   benchmark row. The original disagreement text stays; resolution is annotated, not erased.
6. **Follow-on work:** the canonical-object clone variant entry is superseded (now in-ADR); the
   tree-request-term entry gains "Option 2c eliminates this term; if Option 1 is confirmed the
   term survives and keeps its own ADR"; Option 3's entry gains the concrete measurement vehicle
   (§4.4's offline analysis + warm scenario).

## 6. Sequencing

| Step | Vehicle | Content |
|---|---|---|
| A | PR #27 (this branch) | This plan + the §5 ADR edits. ADR stays `proposed`. |
| B | Follow-up PR | Harness, proposed-grammar module, corpus pinning + verification, workload/ground-truth artifacts, planner unit tests. |
| C | Follow-up PR | The run: `runs.jsonl`, `report.md`, cap-sweep results, Option-3 analysis, rule verdict. |
| D | Follow-up PR | ADR status flip (or Decision Outcome rewrite per §4.7's mapping). |

Step B/C/D have no calendar deadline — the gate is evidentiary, not temporal — but D1 is only
*fully* discharged at D. Until then the ADR remains `proposed`, which is exactly the reviewer's
position honoured.

## 7. Non-goals

- No production implementation of any option (no seam refactor, no scheduler, no guard changes to
  `readOnlyGuard.ts` — the proposed grammars live beside the bench until an ADR adopts them).
- No CI job that talks to the network.
- No re-litigation of settled ADR content (the M-series measurements, the limits table, the
  fail-closed rules) beyond the §5 edits.

## 8. Ratification points (decision-maker sign-off, recorded in the harness PR)

1. The 2.0× displacement margin (§4.7) — the single most judgment-laden constant.
2. K = 5, the ≈400-file per-repo cap, and the 2 GiB disk gate.
3. Final corpus pinning after slot verification.
4. The symlink policy 2c declares (REST-deref parity with today) — a findings-visible choice.
