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
   → ratification freezes the pre-registered artifacts → run happens → committed report → a Step-D
   decision that itself passes one adversarial review round, whatever its direction. Deliverables
   and closure points in §6.
2. **D2 resolves** by defining **Option 2c** (§3), adding it to ADR-0001's Considered Options with
   a full pros/cons section, reworking the Decision Outcome so the case for Option 1 no longer
   leans on a byte-fidelity argument that 2c defeats, and adding 2c as benchmark driver T2c. The
   selection rule (§4.7) is symmetric — no incumbency margin, and identical review requirements on
   every outcome — so the evaluation is on equal footing by construction.

Both resolutions preserve the ADR's honest posture: the recommendation stays provisional, and the
recorded disagreements stay in the Review history — annotated with how each was closed, not erased.

## 3. Option 2c — per-unit clone, no checkout, canonical-object reads

### 3.1 Definition (production shape)

For each branch unit on the default path (the benchmark's acquisition variants are §4.4):

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
4. Content: **one unit-lived `cat-file --batch` child**, spawned after the coherence check with
   `GIT_NO_REPLACE_OBJECTS=1` in the environment (via the existing
   [buildGitEnv](../../scripts/github.ts#L301) seam — an env var, deliberately, because the guard
   treats a pre-verb global like `--no-replace-objects` as the verb and denies it,
   [readOnlyGuard.ts:225](../../scripts/readOnlyGuard.ts#L225)). The child serves the **existing
   pull-style `ReadFile` seam unchanged** ([unitPipeline.ts:46](../../scripts/unitPipeline.ts#L46)):
   each read looks up the path's OID and size in the ls-tree index, writes one format-validated OID
   line to stdin, and reads exactly one frame. `scanUnit` awaits each read, so there is exactly one
   request in flight — no pipe-deadlock geometry, no batch planning. Child lifecycle: per-read
   deadline; at most one respawn per unit (a second child death fails the unit); kill-escalation on
   unit end or abort.

   **Children draw from their own permit pool, not the subprocess semaphore.** Every REST call in
   this tool is itself a `gh` subprocess taking the global permit
   ([github.ts:1184](../../scripts/github.ts#L1184)), so a unit-lived child *holding* that permit
   while its unit's symlink read awaits a REST permit is a deadlock — certain at permit capacity 1,
   and reachable whenever every permit is held by the child of a unit that is itself blocked on a
   fallback. 2c therefore adds a **separate child-permit pool sized to the unit-concurrency bound**
   (at most one child per in-flight unit, so the pool can always satisfy it), leaving the
   subprocess semaphore to one-shot spawns only. The two-pool design and its deadlock-avoidance
   test (capacity 1, symlink fallback while a child is live) are priced in §3.2's ledger.

   Size-gate semantics follow production exactly: source/CLI reads are gated at 2 MiB using the
   ls-tree size; **manifests and lockfiles are read ungated, as production reads them ungated**
   ([unitPipeline.ts:113](../../scripts/unitPipeline.ts#L113) — no size check precedes those
   reads). The per-frame bound is therefore *the ls-tree size of the requested OID, exactly* — a
   frame exceeding its declared size is a protocol violation and fatal — under an absolute
   per-frame ceiling equal to production's existing spawn-output cap, so an ungated manifest can
   never allocate more than today's REST path could return before the cap kill
   ([github.ts:153](../../scripts/github.ts#L153)); an OID whose declared size exceeds that
   ceiling is refused before request and the read fails exactly as a cap-killed spawn fails today.

**Object-format awareness.** OID validation, ls-tree parsing, and frame verification are keyed to
the repository's object format: 40-hex SHA-1 or 64-hex SHA-256, matching the dual format
`github.ts` already accepts for API OIDs — a hardcoded `^[0-9a-f]{40}$` would regress SHA-256
repositories. Blob self-verification hashes `blob <len>\0<body>` with the matching algorithm.
Mixed-format listings are rejected.

**2c leaves the `ReadFile` seam intact — a correction credited to review round 3.** Earlier drafts
claimed 2c shares Option 1's two-phase prefetch/consume refactor; it does not. Option 1 *must*
restructure `scanUnit` into rounds because a network batch has to accumulate paths before
dispatch. 2c's reads are local, cheap, and on-demand — the interactive child answers the existing
one-path-at-a-time contract directly. The seam refactor is therefore **Option 1's distinct cost**,
and the earlier "common cost, neutral" framing was wrong in Option 1's favour.

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
- *The seam refactor*: not needed at all (§3.1); Option 1 cannot say the same.

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
- A long-lived interactive child as a first-class lifecycle: per-read deadlines, single-respawn
  policy, abort integration, stderr draining throughout, and a **second permit pool** with its
  deadlock-avoidance obligation (§3.1) — where every production subprocess today is one-shot under
  a single semaphore.
- A binary framed-spawn seam: the production spawn is `stdin: "ignore"` and irreversibly
  UTF-8-decodes stdout under a single aggregate byte cap
  ([github.ts:168](../../scripts/github.ts#L168),
  [github.ts:180](../../scripts/github.ts#L180)). The new seam must pipe stdin, parse `--batch`
  framing — `<oid> SP <type> SP <size> LF`, `<size>` raw body bytes, LF trailer, plus
  `<oid> missing LF` records — validating OID echo, type, size (against the ls-tree-declared size,
  exactly, under the absolute frame ceiling), and one-request/one-frame correspondence, streaming
  frame consumption so memory stays O(one frame), draining stderr, and preserving kill-escalation
  and deadline behaviour. The same raw-byte seam serves `ls-tree` — its stdout is consumed as
  bytes (unframed, capped) and validated before any UTF-8 interpretation, since the current spawn
  path's irreversible decode would destroy the very evidence the parser must fail closed on.
- An `ls-tree -z` parser with a closed, byte-exact validation set: NUL-delimited records split at
  the **first TAB** (metadata left, path bytes right — a legal git path may itself contain TAB or
  LF, which then flow into path validation, not record framing); mode in the closed set
  `100644/100755/120000/040000/160000` with exact mode→type coherence; OIDs in the repository's
  object format; blob sizes as bounded nonnegative integers (`-` only for non-blobs); paths
  non-empty, valid UTF-8 (else fail closed — no mojibake keys), canonical under the same rules as
  `isCanonicalTreePath` ([github.ts:774](../../scripts/github.ts#L774)), and unique across the
  listing (duplicates fatal); bounded record length, entry count, and stderr; malformed or
  trailing bytes fatal.

### 3.3 Evaluation stance

2c is the strongest challenger to Option 1. Option 1's distinct costs: the two-phase seam refactor,
the API-wide admission scheduler, admission caps, partial-response handling, cache provenance. 2c's
distinct costs: guard grammar work, the stdin trust boundary, the interactive-child lifecycle, the
framed binary seam, disk on every unit, clone retry/pacing policy. Option 1's distinct asymmetry:
its surface is in-process and exercisable by the existing injected-spawn tests; 2c's includes a
subprocess protocol boundary. Neither ledger can be settled by argument — which is precisely why
D1's benchmark exists, and why §4.7's rule is symmetric: performance is measured, the ledger is
judged by the decision-maker, and no numeric handicap converts one into the other.

## 4. The option-selecting benchmark, specified

### 4.1 Harness

`scripts/benchContentTransport.ts` (flat, matching repo convention), run as
`bun run bench:content`. Standalone: it reuses production modules where realism demands
(selection logic, throttle classification, GraphQL query construction) but never touches the
production database, temp prefix, or production source files. The bench builds its own bench-local
seams, including the **framed binary spawn reader, a declared deliverable prototype** of §3.2's
seam (its parser is a pure function with CI unit tests, including synthetic invalid-UTF-8-path,
TAB/LF-in-path, and malformed-frame fixtures). One test-only accommodation is required and
declared here: `github.test.ts` enforces a repo-wide single-spawn chokepoint, and its allowlist
gains the bench spawn module — a test-list change, not a production-code change; without it Step B
is unimplementable. The bench is not a CI network job; its pure planning functions (batch packing,
corpus validation, frame parser, schedule table) get ordinary unit tests that do run in CI.
Results land in `docs/adrs/0001-benchmark/` as committed artifacts: `corpus.json`,
`bench-config.json`, per-repo `selected/*.json`, `runs.jsonl`, `report.md`.

**What the proposed-grammar module covers.** The harness PR ships the proposed `readOnlyGuard`
grammars as a standalone module (production guard untouched), and the bench asserts against it for
the **transport operations under evaluation**: both exact clone shapes, the `ls-tree` tuple, the
`cat-file --batch` tuple. The SHA-pinned acquisition scaffolding (§4.4) is *bench scaffolding, not
proposed production grammar* — its exact argv tuples are pinned in `bench-config.json` so runs are
reproducible, but no production claim attaches to them. Measurement instrumentation (the disk
sampler, `rate_limit` reads) is bench-local and outside guard discipline entirely.

### 4.2 Corpus

Six slots. Candidates are named now; final pinning (owner/repo, branch, full-length SHA — per
branch for C1) happens in the harness PR, with each slot's qualifying property *verified at
pinning time* and recorded in `corpus.json`. A candidate that fails verification is swapped, not
forced.

| Slot | Purpose | Candidate(s) | Pinning verification |
|---|---|---|---|
| C1 | Multi-branch tree sharing + concurrency probe | `fastify/fastify` (main + released lines, each a pinned named branch unit) | ≥4 branch units (the probe needs 4 streams); ≥80% shared tree OIDs between two of them |
| C2 | Mid-size typical service repo | `nodejs/undici` | 1k–3k files; JS/TS manifests present; REST tree `truncated: false` |
| C3 | Path-heavy tree | `NixOS/nixpkgs` | recursive-tree payload dominated by path bytes; deep nesting; REST tree `truncated: false` (else it is a C4, not a C3) |
| C4 | Truncated tree | `llvm/llvm-project`, else `chromium/chromium` | REST recursive tree returns `truncated: true` at the pinned SHA |
| C5 | Checkout-transforming `.gitattributes` | `PowerShell/PowerShell`, else a `dotnet/*` repo | ≥1 selected file whose checkout bytes **differ between `core.autocrlf=false` and `core.autocrlf=true`** at the pinned SHA — the divergence the probe measures, not merely checkout-vs-blob |
| C6 | Fidelity fixtures: symlink + non-UTF-8 content | `nodejs/node` @ `b2a024b1…` (M9, API-only), plus a small clone-feasible repo with a mode-`120000` entry among selected paths (candidate: `git/git`) and ≥1 selected file whose bytes are not valid UTF-8 | tree lists a mode-`120000` selected entry; the non-UTF-8 entry decodes with replacement characters |

C1–C5 form the **performance corpus** (repeated timed runs). C6 is a **fidelity battery**: untimed,
but fully gate-relevant — **global eligibility (§4.7) spans the performance corpus *and* the
fidelity battery**, so a C6 fidelity or completeness failure disqualifies a driver exactly as a
performance-unit failure does. Its protocol is explicit: each fixture entry runs **once per
applicable driver** (K = 1 — a deterministic byte check gains nothing from repetition). The
`nodejs/node` M9 fixture applies to T0 and T1 only (it exercises REST/GraphQL symlink routes; no
one clones node for it); the clone-feasible fixture repo applies to all four drivers. §4.5's
objective-external rerun predicate applies once per (fixture, driver); a fidelity mismatch is
never rerunnable; a skipped applicable fixture is a G2 failure. Invalid *path* bytes (as opposed
to content) are covered by the parser's CI unit tests with synthetic fixtures — committed
non-UTF-8 paths in stable public repositories are not reliably available, and the failure mode is
a parser property, not a network property.

**Workloads are never truncated.** A prefix cap would structurally favour API drivers (it caps
their per-file requests while clone drivers still transfer the whole branch) and can break the
manifest→source/lockfile dependency shape. *Corpus selection* prefers repos whose natural
selected-set size is ≤ ~500 files for C1/C2/C5; C3/C4 keep their natural (large) sets and §4.8's
feasibility protocol absorbs it. Whatever the production selection selects, every driver resolves
in full.

**C4 runs the production designs, not idealisations.** On a truncated tree, T0 and T1 both fetch
the REST tree, observe `truncated: true`, and take the existing checkout-clone fallback
([orchestrate.ts:823](../../scripts/orchestrate.ts#L823)) — exactly as production routes today and
as Option 1 retains. T2a clones with checkout by definition; T2c takes its no-checkout + `ls-tree`
path. The discriminating comparison on C4 is therefore {REST tree attempt + checkout clone + walk}
vs {no-checkout clone + ls-tree + cat-file}, and every driver resolves the same workload, so the
scenario aggregates comparably. Because T0/T1 materialise a checkout here, the acquisition
scaffolding's checkout step and the §4.5 gitconfig probe apply to them on C4 exactly as to T2a
everywhere.

### 4.3 Workload pinning and ground truth

At pinning time, once per corpus unit (repo × branch):

1. **Pin the bench configuration** as a committed artifact (`bench-config.json`): the
   tracked-package set, exclusion globs, CLI-classifier terms, size-gate constants, T1 caps and
   failure-policy constants (§4.4), the full traversal/order schedule (§4.5), the projected-spend
   formulas (§4.8), and the exact scaffolding argv tuples. The workload is a function of
   (config, repo, SHA) and all three are pinned.
2. Run the production selection logic (manifest location → lockfile election → source/CLI gates)
   against the pinned SHA via the status-quo path, recording the final selected set: `{path, mode,
   blobOid, size, class}` per entry, committed under `selected/`.
3. Record ground truth per entry as a **route-expectation matrix** over the **complete route
   vocabulary**: `primary`, `symlink-fallback`, `binary-fallback` (a GraphQL blob flagged
   `isBinary`/null-`text`), `truncated-blob-fallback`, `content-cap-singleton` (T1),
   `missing-alias-fallback` (T1), `batch-error-fallback` (T1), `binary-lockfile-skip`,
   `size-gate-skip` (source/CLI above 2 MiB — never read by any driver), and
   `truncated-tree-checkout` (the C4 fallback). For each (entry, driver): the **expected primary
   route**, the
   **permitted fallback set** (pinned — a delivered route outside it is a G2 failure, so no
   post-hoc relabeling is possible), and the expected *seam-level string* per permitted route
   (sha256 of the UTF-8-decoded bytes that route delivers — REST-dereferenced bytes for symlink
   fallbacks, decoded blob bytes elsewhere), plus the canonical blob-bytes hash for raw-capable
   verification (T1 hash-validated text; T2c pre-decode frames). Routes are additionally marked
   **primary** or **declared-caveat** (§4.7's G1 treats them differently; the only caveat route
   in this matrix is `truncated-tree-checkout` for T0/T1, retained by documented design — for
   T2a checkout reads are the primary route and get no such shelter). Symlink REST expectations
   are deterministic because the dereference target is pinned by the same commit. **Every driver
   carries the same REST fallback budget** — max(20, 10% of selected), exceeded → unit failure —
   not just T1; symlink-heavy units spend it fastest and the pinning-time mode census makes the
   expected spend known in advance. Pinning tooling is unconstrained (full local clone, plain
   git; not a measured activity).

### 4.4 Drivers

| Driver | Option | Shape |
|---|---|---|
| T0 | Status quo | REST `contents` per file, production Accept header, production concurrency semantics, production throttle classification |
| T1 | Option 1 | Aliased GraphQL blob batches under **fixed pre-declared caps and failure policy**; two-round dispatch exactly as the production design forces; per-alias hash validation; symlink/binary/truncated → REST fallback, counted |
| T2a | Option 2a | Option 2a *as considered in the ADR, made faithful*: shallow clone + checkout, `ls-tree` enumeration for modes/sizes/paths, working-tree reads for regular blobs, mode-routed symlink policy (REST fallback), head-coherence check |
| T2c | Option 2c | §3.1 exactly: no-checkout acquisition, `ls-tree -r -z -l`, unit-lived `cat-file --batch` child serving pull-style reads, seam-level UTF-8 decode |

**Drivers implement the considered designs, minimally.** Each driver is the minimal faithful
implementation of its option as evaluated in the ADR — including the parts today's code lacks.
T2a's mode and size source is `ls-tree`, not `lstat`: the ADR's own Option 2a analysis says a
correct symlink policy "needs index/tree modes", `lstat` cannot identify links under
`core.symlinks=false`, and reading modes from committed fixture metadata would be circular. That
prices the `ls-tree` verb and parser into **both** clone options' ledgers, and §5's ADR edits
rescope 2a's size-gate and symlink objections accordingly — they are fixable at the cost of the
verb; the byte-fidelity objection to checkout *reads* stands untouched.

**T1's failure policy is fixed before the matrix, not improvised during it.** Declared in
`bench-config.json`: caps — alias 250 (M2's measured point), query-document 48 KiB, per-batch
content estimate 1.5 MiB (deliberately below M5's 3.0 MB single point, which ran at half this alias
cap; the alias×content interaction is unmeasured, so the matrix cap keeps margin and the boundary
probe maps the interaction), argv 128 KiB. A selected entry that alone exceeds the content cap —
possible, since manifests and lockfiles are read ungated — is routed to the REST fallback with
cause `content-cap-singleton`, counted. Failure policy, all constants literal: transient 5xx —
bounded retry within **6 total attempts** (the literal value of production `MAX_ATTEMPTS`,
[github.ts:1000](../../scripts/github.ts#L1000)), never split on first failure; split trigger —
a GraphQL error whose `type` is `TIMEOUT` (or message matching the pinned timeout regex in
`bench-config.json`), or two consecutive HTTP 502/503/504 responses with empty or non-JSON bodies
on a batch whose alias count or query bytes are ≥ 80% of cap; binary split with descendant depth
≤ 2 and ≤ 4 descendants per original batch; circuit breaker — 3 consecutive failed dispatches
abort the unit (a G2 event); per-unit REST fallback budget — max(20, 10% of selected), exceeded →
unit failure; partial responses — per-alias resolution via `data` + `errors[].path`, an alias
absent from both retried once at batch level then routed to fallback (counted).

**Clone acquisition: production argv by default, SHA-pinned scaffolding as the drift fallback —
never mixed within a unit.** `git clone --branch` takes a ref name, not a SHA, so a branch that
advances after pinning would silently shift the workload. Before a unit's **first** clone-driver
run — outside the timed window — the harness probes the live head with
`git ls-remote <corpus-url> refs/heads/<branch>` (the exact-ref form against the corpus URL — at
probe time no clone exists, so there is no `origin` to name — requiring exactly one result line).
Head equal to the pinned SHA → **all** of that unit's timed clone-driver runs use the production
`cloneShallow` argv (T2a/T0/T1-on-C4 with checkout; T2c with `--no-checkout`), with the probe
re-run before every rep; a mid-unit drift **discards the unit's collected reps and restarts the
whole unit on the scaffolding form** (a freeze-sanctioned restart, recorded — medians never mix
acquisition forms). Head already drifted → all reps use the SHA-pinned scaffolding:
`git init --template= --object-format=<format> <dir>` (the object format recorded in
`corpus.json` at pinning — a plain `init` would default to SHA-1 and be unable to fetch from a
SHA-256 repository) → `git remote add origin <url>` →
`git fetch --depth 1 --no-tags --no-recurse-submodules origin <sha>` →
`git checkout --detach FETCH_HEAD` for any driver materialising a working tree (T2a everywhere;
T0/T1 on C4), while T2c addresses objects by the pinned SHA directly (`ls-tree … <sha>`;
`rev-parse FETCH_HEAD` asserted equal to `<sha>`, since a bare fetch leaves no `HEAD`). Every run
records which form it used. At pinning time, both forms run **three times each** per clone driver
as **non-decision diagnostics**: identical tip and tree OIDs and an identical object set are
asserted (`git rev-list --objects <sha>`, sorted and hashed — pinning tooling is unconstrained),
and the medians' wall-time delta is recorded; any delta > 10% is flagged so scaffolding-form units
are interpreted with that bound in hand rather than folded silently into a noise-band comparison.
If a pinned SHA becomes unreachable entirely (force-push), the fetch fails loudly and the slot is
re-pinned — under §8's freeze, a re-pin restarts that unit's matrix.

**Option 3 is not a driver.** It is evaluated the way the ADR already recommends: an offline
duplicate-OID analysis over the corpus trees (cheap, no network), reported alongside — plus one
warm-run scenario (advance C1 one commit, re-run with and without OID-keyed caching) executed on
the rule's recommended driver if one exists, else on both finalists (T1 and T2c). For clone
drivers the analysis must state what git's native object reuse already provides — OID-keyed
caching largely composes with *API* read paths, and the report says so rather than pretending a
uniform layer.

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
- **Ordering — the full traversal is preregistered**, not just per-unit driver order: a literal
  (unit × driver × repetition) sequence table in `bench-config.json`. Within each unit, driver
  orders across repetitions follow a Williams design (digram-balanced Latin square — each driver
  once in each position, each ordered predecessor pair exactly once) plus a declared fifth order
  minimising repeated digrams. Across units, the sequence interleaves repositories so that no two
  C1 branch units (same repository) are adjacent — server-side pack-cache warmth from one branch's
  acquisition must not systematically precede its sibling's.
- **Cold** means: no `api_cache` rows, no reused clones, no HTTP cache. DNS/TLS warmth is ambient
  and shared.
- **Washout:** at least 60 seconds of API idle separate consecutive runs. GitHub's secondary
  limits are rolling per-minute windows (900 REST points/min, 2,000 GraphQL points/min), so
  without a washout one driver's burst could push its *successor* over a rolling threshold and
  ordering would decide eligibility; the idle gap drains the window so a secondary-limit signal
  lands on the driver that caused it.
- **Completion discipline:** eligibility requires all K runs complete (G3). One rerun per
  (unit, driver) is permitted only for an **objectively external** failure: a network-layer error
  outside any HTTP response (DNS/TLS/connect/reset), or an HTTP 5xx on a request that was within
  all declared caps *and* whose request class succeeded in at least one other repetition. A
  cap-exceeding batch's 5xx, a guard rejection, a parse failure, a coherence failure — driver
  failures, no rerun. Secondary-limit signals are **not** rerunnable under this predicate; their
  consequences are G4's alone. Failed attempts always stay in `runs.jsonl`, count in the failure
  metrics, and their API consumption counts in budget accounting; the replaced attempt's timing is
  excluded from throughput aggregation (it resolved no complete workload) and the rerun's enters.
- **Checkout-config probe:** every run configuration that materialises a checkout — T2a on all
  units, T0/T1 on C4 via the truncated-tree fallback — gets one additional repetition under
  `core.autocrlf=true` (matrix reps run `false`). Any seam-level byte divergence between the two
  configs on the same entry is a G1 event on that route. The claim this probe supports is
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
2. HTTP requests by class: REST content, REST tree, REST fallback, GraphQL requests. **Bucket
   consumption is the authoritative figure**: the before/after `rate_limit` delta per bucket
   (the PAT is dedicated to the bench and idle otherwise, declared in §4.8, so the delta is the
   run's own). Per-request `rateLimit { cost }` sums are the explanatory breakdown, with **1 point
   imputed** per GraphQL attempt that returned no readable cost (502s, timeouts, non-JSON bodies —
   GitHub's documented minimum, and timeout penalties land in the header delta regardless); if the
   header delta exceeds the reconstructed sum, the delta governs. Consumption can be
   under-reported by neither path.
3. Transfer, reported as two explicitly non-comparable kinds: HTTP body bytes (API drivers) and
   on-disk object-store bytes after acquisition (clone drivers — labelled on-disk, since git
   reports no clean transfer-byte figure without packet tracing).
4. Peak disk under the run's temp dir, measured as a **sampled peak**: a bench-local sampler polls
   the run directory's usage at 1 Hz and takes the maximum, supplemented by post-acquisition and
   post-run point measurements; declared as sampled-peak-at-1 Hz, an approximation by nature.
5. Failures: 5xx, timeouts, retries (attempt-counted), fallback count by cause (symlink, binary,
   truncated, content-cap-singleton, batch-error), incomplete entries, secondary-limit signals by
   kind, rerun usage with recorded cause.
6. Fidelity: every delivered entry checked against the §4.3 route-expectation matrix at the string
   seam; raw-capable drivers additionally verify pre-decode bytes against the canonical blob hash.

**Scoring, paired per run.** For each run *r*: `wallThroughput(r) = 3600 × files ÷ wall(r)`; for
each bucket the run consumed from, `bucketCeiling(r) = 5000 × files ÷ units(r)` (a bucket with
zero consumption imposes no ceiling); `T(r) = min(wallThroughput(r), min over consuming buckets of
bucketCeiling(r))` — each run pairs its own wall with its own consumption; walls and units are
never mixed across runs. Per (unit, driver) the score is the **median of T(r) over the K runs**,
with worst-of-K reported beside it. Tree acquisition counts toward units (T0/T1 pay it; T2a/T2c do
not); discovery (repo/branch listing) is excluded as identical across drivers. Results are
reported per bucket size so 15,000-point credentials read off the same data.

> **Scope, stated plainly:** this is a per-scenario serial cost profile, *not* an estate
> simulation. It does not exercise concurrent fan-out, the shared REST+GraphQL CPU budget under
> contention, cross-unit cache effects, or aggregate clone disk across parallel units. Those
> remain design-ledger items (§4.7); the concurrency probe (§4.5) evidences them without scoring
> them.

### 4.7 Pre-registered rule: eligibility, comparison, and who decides

**Eligibility is global per driver** — a driver that fails any gate on any unit of the performance
corpus *or* the fidelity battery is ineligible, full stop. Per-unit exemptions would let hard
scenarios quietly vanish from the comparison. The gates:

- **G1 Determinism/fidelity, route-scoped:** on **primary routes**, delivered strings must match
  the route-expectation matrix for every entry in all reps, raw-capable verification must pass
  where declared, and no divergence may appear under the checkout-config probe — any violation
  disqualifies. On **declared-caveat routes** (only `truncated-tree-checkout` for T0/T1, retained
  by documented design), the waiver is *exactly the config delta and nothing more*: all baseline
  (`autocrlf=false`) repetitions must still byte-match each other **and** the pinned
  baseline-config expectation — corruption, truncation, or rep-to-rep instability on a caveat
  route disqualifies like any primary route — while divergence between the baseline and the
  `autocrlf=true` probe rep is recorded as a first-class finding for the decision-maker rather
  than auto-disqualifying. T2a gets no such shelter because checkout reads are its *primary*
  route. Disqualification is by observed divergence, not by suspicion.
- **G2 Completeness:** every workload entry resolves via its declared route; a whole-batch failure
  surfacing as silent per-entry absence is a G2 failure, not a fallback; fallback-budget
  exhaustion and circuit-breaker aborts are G2 failures.
- **G3 Stability:** all K reps complete, within §4.5's rerun discipline.
- **G4 Envelope:** sampled-peak disk ≤ 2 GiB per unit (ratifiable constant). Secondary-limit
  conduct is pass/fail with an objective classifier: a signal is **attributable** when it occurs
  on the driver's own request during a matrix run (probe and pinning traffic excluded). Zero
  attributable signals = pass; exactly one = pass with a recorded warning (no rerun — §4.5's
  predicate does not cover secondary signals); two or more = fail.

**Comparison (symmetric — no incumbency margin):** per performance-corpus unit, compare eligible
drivers' scores; differences within the **noise band** are a tie for that unit. The band is
`max(1.25, pilot spread)` where *pilot spread* is the max/min wall-time ratio observed in a
pre-ratification diagnostic pilot (K = 5 reps of T0 on C2, declared non-decision), rounded up to
the next 0.05 — the band is calibrated by a preregistered formula rather than asserted. This
yields a per-unit win/tie/loss table. A driver **dominates** when, against every other eligible
driver, it has at least one unit-win and no unit-losses.

For **segmented runs** (§4.8), the wall term is unreliable by construction (bucket resets
punctuate the workload), so a segmented run's `T(r)` uses the bucket-ceiling term alone — which is
exact, since units-consumed are exact — with both terms shown in the report. In practice this
affects T0 on C3/C4-scale units, where the ceiling term is the operative reality regardless.

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
- 0 eligible → no recommendation and **no path to `accepted` on this benchmark**: Step D records
  remain-`proposed` with a remediation plan (which gate failures to fix, what re-runs under §8's
  freeze rules), and D1 discharges through that recorded decision like any other.

**Who decides, symmetrically:** the decision-maker (rvo) makes the ADR decision in every case —
ratifying the rule's recommendation or overriding it. Hard constraints: an **ineligible driver can
never be chosen**; **every Step-D outcome — ratification, override, no-dominator judgment, or
remain-proposed-with-remediation — passes one further adversarial review round before the ADR
changes state**, with any override's written rationale recorded in the ADR's Review history. No
path out of Step D skips review, in either direction.

### 4.8 Budget, feasibility, and safety

- **Reserved spend is a worst-case bound, not an estimate.** Every consuming loop in every driver
  is capped — attempts ≤ 6, REST fallbacks ≤ the budget, splits ≤ 4 descendants per batch,
  reruns ≤ 1 — so each run's worst-case bucket consumption `WC` is *computable exactly* from the
  pinned workload and constants: REST — (per-file requests + tree requests + fallback budget) ×
  attempt cap + the fixed per-run overhead; GraphQL — planned batches × (1 + descendant cap)
  points × attempt cap, every attempt imputed ≥ 1 point. The harness prints `WC` per bucket
  before each run and proceeds only if `WC × 1.1 ≤ headroom` — reserving the worst case up front
  is what makes "sleeps happen *between* runs, never inside one" actually hold; an expected-value
  guess with a 1.5 fudge factor could exhaust a bucket mid-run and force the very mid-run stall
  the protocol forbids. A run that somehow exceeds its `WC` is a harness defect: the run aborts,
  the data is discarded, and §8's freeze treats the fix as a harness change (matrix restart). The
  harness is **bucket-aware and resumable**: below the reserve it sleeps to the reset epoch;
  partial results persist and resume.
- **Feasibility gate:** if a single run's `WC × 1.1` exceeds a bucket's *full capacity* (5,000),
  no reset can ever satisfy the guard. Such runs (realistically: T0 on C3/C4-scale units) execute
  in **segmented mode**: the workload splits into pinned contiguous segments each satisfying the
  guard, segments run in successive bucket windows, the clock pauses between segments, and the
  segmentation is reported; scoring per §4.7's segmented-run rule.
- **The bench credential is dedicated**: a PAT used by nothing else for the duration of the
  matrix, so before/after `rate_limit` deltas attribute cleanly (§4.6) and no foreign consumption
  can trip the reserve.
- Git pacing: well under 15 ops/s/repo by construction (≤ a handful of transport subprocesses per
  run); asserted in the report.
- The bench runs against github.com with an ordinary PAT on public repos only, so every artifact is
  reproducible by anyone.

## 5. ADR-0001 edits (applied in this PR once this plan converges)

1. **Considered Options:** add Option 2c.
2. **New pros/cons section** for Option 2c carrying §3's ledger — neutralised objections
   (including the seam refactor Option 1 needs and 2c does not), inherited costs, new surface —
   with code links.
3. **Decision Outcome:** rework the paragraph that stacks the `cat-file` cost onto "the disk,
   sweep, symlink, and routing problems" to decide against "the clone options" collectively — 2c
   dissolves the symlink and routing members of that list and pays the `cat-file` cost to dissolve
   the byte-fidelity one, so the argument must be re-scoped to 2a, and the case for Option 1 over
   2c restated as §3.3's ledger asymmetry, explicitly benchmark-gated and decided under §4.7's
   symmetric rule. Name 2c the strongest challenger. The seam-refactor cost item moves from
   "shared by any batching design" to Option 1's own column.
4. **Option 2a's section** is rescoped, not just annotated: the mode-source correction (a faithful
   2a needs `ls-tree` for symlink routing — `lstat` cannot do it under `core.symlinks=false`), and
   the size-gate objection (`walkClone`'s attribute-dependent `lstat` sizes) marked *fixable* via
   ls-tree canonical sizes at the cost of the new verb — leaving byte fidelity of checkout *reads*
   as 2a's standing decisive defect.
5. **Confirmation:** replace the four-line gate sketch with a summary of §4 and a link to this
   plan: corpus slots, drivers (2c included; Option 3 restructured to the compositional analysis),
   global eligibility gates spanning both corpora, the calibrated noise-band comparison with its
   exhaustive case mapping, and the universal one-round re-review of every Step-D outcome. The
   "predeclared margin" promise becomes an actual predeclared rule.
6. **Review history:** annotate the two disagreements with their resolution state, without erasing
   the original record — and with matching closure semantics: **each disagreement's resolution is
   committed by this PR and discharged by evidence.** D2's commitment is the in-ADR Option 2c
   evaluation plus its benchmark row; it discharges at Step C, when T2c's row has actually run —
   claiming it closed before the variant is measured would repeat the original sin of deciding by
   scheduling. D1's commitment is the binding benchmark spec; it discharges at Step D, when the
   evidence-based decision is recorded. Until then the ADR remains `proposed` — which is the
   reviewer's position honoured.
7. **Follow-on work:** the canonical-object clone variant entry is superseded (now in-ADR); the
   tree-request-term entry gains "Option 2c eliminates this term; if Option 1 wins, the term
   survives and keeps its own ADR"; Option 3's entry gains the concrete measurement vehicle
   (§4.4's offline analysis + warm scenario).

## 6. Sequencing

| Step | Vehicle | Content | Closure state after step |
|---|---|---|---|
| A | PR #27 (this branch) | This plan + the §5 ADR edits. ADR stays `proposed`. | D1 and D2 committed; D2 discharges at C, D1 at D |
| B | Follow-up PR | Harness, proposed-grammar module, framed-reader prototype, chokepoint-test allowlist entry, corpus pinning + verification, `bench-config.json` (caps, failure policy, schedule table, scaffolding argv, spend formulas), workload/ground-truth artifacts, diagnostic pilot, planner unit tests. **Ratification (§8) happens here, before any timed matrix run.** | D1 executable |
| C | Follow-up PR | The matrix: `runs.jsonl`, `report.md`, boundary probe, concurrency probe, Option-3 analysis, rule output. | D2 discharged (T2c measured); D1 evidence complete |
| D | Follow-up PR | Decision per §4.7's case mapping — accept, rewrite-for-winner, no-dominator judgment, or remain-proposed-with-remediation — then **one adversarial review round on the decided ADR text, every outcome, every direction**, then the state change (if any). | D1 discharged |

Steps B–D have no calendar deadline — the gate is evidentiary, not temporal.

## 7. Non-goals

- No production implementation of any option (no seam refactor in production code, no scheduler,
  no guard changes to `readOnlyGuard.ts` — the proposed grammars and the framed-reader prototype
  live beside the bench until an ADR adopts them). The single declared exception: the
  spawn-chokepoint test's allowlist gains the bench module (§4.1) — a test change, without which
  the bench cannot exist.
- No CI job that talks to the network.
- No re-litigation of settled ADR content (the M-series measurements, the limits table, the
  fail-closed rules) beyond the §5 edits.

## 8. Ratification and freeze

Decision-maker sign-off, recorded in the harness PR **after the diagnostic pilot and before any
timed matrix run**:

1. The noise-band formula's output (the calibrated band) and the dominance definition (§4.7).
2. K = 5, the 2 GiB per-unit disk gate, the G4 secondary-limit threshold, and the fixed T1 caps
   and failure-policy constants (§4.4).
3. Final corpus pinning after slot verification, including accepting C3/C4's natural workload
   sizes and their budget cost.
4. The symlink policy all drivers declare (REST-deref parity with today) — a findings-visible
   choice.

**Freeze semantics — the frozen set is everything the result depends on:** corpus SHAs and
branches, selected sets, route-expectation matrices and ground-truth hashes, every
`bench-config.json` constant (gates, caps, failure policy, noise band, dominance definition,
schedule table, scaffolding argv, spend formulas), **the harness source revision**, and **the
execution environment** — one machine for all timed data, with an environment manifest (OS and
version, hardware identifier hash, git/Bun/gh versions, network location description, credential
type) recorded once and stamped into every `runs.jsonl` record alongside the harness commit SHA.
Local-subprocess wall times and remote-API wall times are only comparable when both were measured
from the same box over the same network. After ratification, any change to any frozen artifact —
a re-pin after upstream force-push, a mid-unit acquisition-form switch (§4.4: the unit restarts),
any harness code change, or an environment change — invalidates the affected timing data (the
unit restarts; a harness or environment change restarts the whole matrix) and requires amending
this plan plus one adversarial review round on the amendment before new timing data is collected.
Pre-registration that can be edited mid-run is not pre-registration.
