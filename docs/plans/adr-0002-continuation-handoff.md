# ADR-0002 continuation handoff — review rounds 6–10, then the implementation plan

**You are a fresh session picking up committed, in-flight work. This document is your complete
brief.** Read it top to bottom before acting. Where it conflicts with your defaults, it wins;
where the ADR's own text conflicts with this summary of it, the ADR wins.

## Mission (two phases, strictly ordered)

* **Phase A — continue the adversarial review** of
  [docs/adrs/0002-branch-discovery-rate-limit-strategy.md](../adrs/0002-branch-discovery-rate-limit-strategy.md)
  with `/codex`, for **up to 5 additional rounds (rounds 6–10)**. Converge (APPROVE) or cap.
* **Phase B — author the implementation plan** as a new committed document,
  `docs/plans/adr-0002-implementation.md`, written so a *fresh implementation session* can
  execute it with no other context. Its mandatory properties are specified below (§ Phase B):
  `/codex` as outside voice on every substantial step, red → green TDD throughout, and a final
  `/santa-loop` gate with a **7-round ceiling** (explicit override of the default 3).

Phase B happens regardless of Phase A's outcome — if round 10 still says REVISE, close the loop
capped-not-converged (verified final-round findings applied post-cap, disclosed), then proceed.
The recommendation (Option 1, alias-batched refs page-1 discovery) has never been contested in
any round; only claims, arithmetic, rule completeness, and evidence discipline have moved.

## State of the world (as of this handoff)

* **Branch**: `claude/graphql-rate-limit-madr-2c2d90`, based on `main` @ `1ebd061` (PR #36's
  squash). **PR #38** is open against `main`, `MERGEABLE`, CI green at handoff time. Work in
  this branch (or a worktree of it); push to it — PR #38 rides along.
* **The ADR**: `docs/adrs/0002-branch-discovery-rate-limit-strategy.md`, 799 lines, status
  **proposed** (rvo ratifies; that gate is not yours). Five options; Decision Outcome = Option
  1 with a fully specified design (staged/partitioned envelope seam under a one-door rule,
  cause-tagged exhaustion, window bounds: age cap + head budget, degrade-and-downshift,
  `batchSize: 1` normative bypass, pre-registered live cost probe that pins the batch default).
  Its **Review history** section is the authoritative loop record.
* **Review loop so far**: 5 rounds with Codex (gpt-5.6-sol @ ultra). Verdicts **REVISE ×5**
  (findings per round: 15+4, 15+3, 17+5, 21+11, 14+3 = 108 total). Every code-checkable finding
  was verified against the sources and found correct; all 108 were applied. **Round 5's 17
  fixes were applied AFTER the cap and are UNREVIEWED** — the ADR's Review history discloses
  this. Two items are delegated to the implementation bill by name with constraints recorded:
  the config-hash treatment of `discovery.batchSize` (must not perturb the §3 skip predicate)
  and any extension of the per-alias `NOT_FOUND`/`FORBIDDEN` family (authoritative or
  field-observed evidence + decision-maker sign-off + fixtures).
* **Codex session**: thread id `019fd023-7e70-7710-b1e4-d85784e40178` (also in
  `.context/codex-session-id`, untracked). It holds all five rounds of the reviewer's own
  analysis. **Prefer resuming it** so round 6 can check its round-5 findings' applications
  against its own intent; if resume fails, start a new thread — the ADR's Review history is the
  shared record either way.
* **Memory**: this project's memory index has
  `package-audit-adr-0002-graphql-rate-limit.md` covering the same state, plus operational
  memories referenced below.

## Operational recipe for /codex (hard-won this session — follow it)

Invoke the `/codex` skill for the preamble/auth probe, then use this shape per round (Consult
mode, path-referencing, lean packet — codex reads the repo itself):

```bash
codex exec resume 019fd023-7e70-7710-b1e4-d85784e40178 "<round packet>" \
  -c 'sandbox_mode="read-only"' -c 'model="gpt-5.6-sol"' \
  -c 'model_reasoning_effort="ultra"' -c 'service_tier="priority"' \
  --enable web_search_cached --json < /dev/null
```

* Wrap with the skill's timeout helper at ~560 s and give the Bash call a 600 s timeout.
  **Expect the wrapper to cut ultra off mid-analysis roughly every round.** That is not
  failure: the thread survives. Recover with
  `codex exec resume <id> "Interrupted before emitting. Finish in-flight checks and emit your
  numbered [P1]/[P2] findings NOW, ending with the single VERDICT line. No new broad
  re-reads."` — expect 1–2 such resumes per round.
* Parse the `--json` stream (`item.completed` → `agent_message` / `command_execution`;
  `thread.started` → session id). In zsh use `${pipestatus[1]}` (lowercase, 1-indexed) — not
  `PIPESTATUS`.
* `mktemp` in the system temp dir is sandbox-blocked; write scratch files under the session
  scratchpad directory.
* Every packet starts with the skill's filesystem boundary (no `~/.claude/`, `~/.agents/`,
  `.claude/skills/`, `agents/`) and ends with the output contract: numbered findings, each
  `[P1]` (must fix) or `[P2]` (advisory), then exactly one line `VERDICT: APPROVE` or
  `VERDICT: REVISE`.

## Phase A — rounds 6–10 protocol

**Round 6 packet, specifically**: (1) the 17 round-5 findings were applied post-cap and are
unreviewed — verify each application is faithful to the finding's intent, listing any
mis-application as a P1; (2) then a full fresh adversarial pass of the whole file with the same
standard as prior rounds (factual accuracy vs. cited sources, arithmetic, option completeness,
decision soundness, internal consistency of the design's state machine, MADR/house style vs.
ADR-0001).

**Between rounds** (unchanged discipline from rounds 1–5):

1. **Verify before applying.** Check every code-checkable finding against the actual sources
   (`scripts/github.ts`, `scripts/orchestrate.ts`, `scripts/db.ts`, `scripts/preflight.ts`,
   `scripts/config.ts`, `PROMPT.md`, ADR-0001 + its benchmark artifacts). This session's hit
   rate for codex findings was effectively 100% (32/32 verified in round 4 alone) — verify,
   then accept fast. A refutation is a claim to check like any confirmation.
2. **Apply all verified findings.** Judgment calls: implementation-spec depth beyond the
   decision's needs may be **delegated to the implementation bill by name with the constraint
   stated** (two precedents already recorded); genuine disagreements are **recorded, not
   smoothed**, in Review history — never silently dropped.
3. **Record the round in the ADR's Review history** (verdict, counts, headline corrections,
   delegations), matching the voice of rounds 1–5.
4. **Commit per applied round**: `docs(adr): ADR-0002 review round N applied` — push after each
   so PR #38 tracks the loop.

**Termination**: APPROVE at any round → loop converged; update the Review history closing
status accordingly. REVISE at round 10 → apply verified findings post-cap with the same
disclosure pattern round 5 used, state plainly that no APPROVE round occurred, and proceed to
Phase B. **Never claim convergence that did not happen** — the standing closing line
("five-times-adversarially-reviewed but not reviewer-approved") must be updated to reflect the
true final state (e.g. ten-times / converged-at-round-N).

**At Phase A close**: sync the PR #38 body — the round table (currently rounds 1–5) and the
loop-status sentence must match the final Review history exactly. Body drift is a known failure
class in this repo; prose reviews check it.

## Phase B — author `docs/plans/adr-0002-implementation.md`

**Before writing, read** [adr-0001-t2c-implementation.md](adr-0001-t2c-implementation.md) for
the house shape of an implementation plan, and the final (post-Phase-A) ADR text — **the ADR's
"The design, concretely" and Confirmation checks 1–7 are the plan's requirements; the plan
sequences and operationalizes them, it does not re-decide them.** The plan must be
self-contained for a fresh session: state of the world, file map with line anchors, invariants
that constrain work, step list with per-step acceptance, and the gates below.

**Mandatory structural properties** (the user's explicit requirements — non-negotiable):

1. **Red → green TDD for every step.** Each step is specified as: write the failing test first
   (RED — run it, confirm it fails for the intended reason), minimal implementation (GREEN —
   run it, confirm pass), refactor, full `bun test` before the step's commit. Repo constraints
   that shape HOW tests may be written (from memory + prior PRs): the logVocab pin fails on new
   JSONL event tokens until declared; the sole-spawn-site and no-nonliteral-dynamic-import
   scans constrain test structure, and spelling certain tokens in comments trips them; scripted
   GithubClient fixtures + real in-memory DB is the established test idiom for
   discovery/orchestration; fix the implementation, never the test, unless the test itself is
   proven wrong.
2. **`/codex` as outside voice on every substantial step.** The plan must define "substantial"
   concretely — at minimum: the probe harness and its pre-registered rule execution; the
   envelope seam (`errors[].path` surfacing, cause-tagged exhaustion, classify → stage →
   partition order); the batch builder (variables-only binding); the window machinery
   (prefetcher, staging-through-consumption, age cap, head budget, Aborter integration);
   degrade/downshift; the orchestrate + `--plan` integration; the config key + schema + the
   delegated config-hash decision; the PROMPT.md §5.B spec amendment. After each substantial
   step lands: `/codex review` scoped to that step's diff; verified findings fixed before the
   next step begins. Mechanical steps (docs lines, re-exports) don't need it — the plan says
   which steps are which.
3. **Final `/santa-loop` with a 7-round ceiling.** The plan's last gate before requesting
   rvo's merge review: invoke `/santa-loop` **explicitly overriding the round ceiling to 7**
   (pass the override in the invocation args; if the skill exposes no parameter, state the
   7-round cap in the loop instructions — the convergence rule, all three reviewers NICE, is
   unchanged; only the ceiling moves). Known operational facts: the triple is Opus 4.6 @ xhigh
   + gpt-5.5-pro @ xhigh + gpt-5.6-sol @ ultra; ultra times out on big packets — keep packets
   lean; **reviewer isolation is mandatory** (never `git add`/commit while a reviewer agent is
   live; verify `HEAD == tree` before push — a reviewer's mutation test once got committed in
   this repo); santa loops here have historically NOT converged in 3 rounds — if 7 rounds
   don't converge, record capped-not-converged with standing positions and escalate to rvo;
   never report NICE that didn't happen.

**Sequencing requirements the plan must encode** (from the ADR's own gates):

* **The probe comes first and gates everything.** Confirmation check 1 is pre-registered: the
  probe harness (benchGh/benchBoundary-style, per-call `rateLimit{cost}` in both arms, frozen
  corpus, full same-owner batches, control cleanliness, contiguous-passing-prefix rule) runs
  live, its artifact is committed beside `boundary-probe.json`, and its output **pins the
  shipped default or returns the ADR to the decision-maker** (no-pass outcome). The live run
  needs the confirmed gh identity — check the `package-audit-live-test-identity` memory before
  spending; the spend itself is trivial (tens of points).
* **rvo's ratification of the ADR (proposed → accepted) sits between probe evidence and the
  main build** — mirror ADR-0001's Step-D pattern: the ADR's state change rides a PR with the
  evidence, gated by adversarial review. The plan schedules the ratification ask; it does not
  perform it.
* The remaining build order should follow dependency structure (seam → builder → window →
  degrade → integration → config/schema → spec bill → suite + santa-loop + body sync), each
  step carrying its Confirmation-check linkage so nothing in checks 2–7 is left unowned.
* The two **named delegations** must appear as explicit plan steps with their recorded
  constraints (config-hash treatment decided against how existing operational-only keys are
  handled and documented; family extension needs evidence + sign-off + fixtures).

**Phase B close**: commit the plan (`docs(plans): ADR-0002 implementation plan — TDD + codex
outside voice + santa-loop(7)`), push, sync the PR #38 body to mention it, and end your session
by outputting a short kickoff prompt for the implementation session (point it at the plan file;
one paragraph, since the plan itself is the brief).

## Standing guardrails (apply to both phases)

* Conventional commits; commit and push at each checkpoint named above; never force-push this
  branch.
* PR-body accuracy is a reviewed surface: every claim in the body must match the repo state at
  push time.
* `bun test` green before every push (2,608 tests at handoff; the suite runs in ~30 s).
* Do not touch `docs/adrs/0001-*` or benchmark artifacts; evidence files are append-only
  precedent in this repo (evidence tags NEVER delete).
* The ADR stays `proposed` throughout both phases — nothing you do accepts it; rvo does.

## Kickoff (your literal first actions)

1. Confirm you are on `claude/graphql-rate-limit-madr-2c2d90` (or a worktree of it), clean,
   with `origin` current; read the ADR end to end, then this file's Phase A protocol.
2. Run the `/codex` skill preamble + auth probe. Confirm `codex --version` ≥ 0.146 and
   `AUTH_OK`.
3. Launch round 6 with the round-6 packet above (resume thread
   `019fd023-7e70-7710-b1e4-d85784e40178`; fall back to a fresh thread only if resume fails).
4. Proceed per protocol. When Phase A closes, execute Phase B. Do not stop between phases to
   ask permission — this document is the authorization for both.
