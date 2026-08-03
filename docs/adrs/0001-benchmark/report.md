# ADR-0001 content-transport benchmark — Step C report

- **Generated:** 2026-08-03T00:05:22.564Z
- **Plan:** [docs/plans/adr-0001-disagreements-resolution.md](../../plans/adr-0001-disagreements-resolution.md) §4.5–§4.8 (protocol, metrics, rule, budget); ratified per §8.
- **Frozen-surface digest:** `8b67a31418531d4da69d044c19d644805c6c910b30cc4037d61edf0b35b80255`
- **Harness commit (rows):** `1e8ea6622f97ddc3764213f0371260029e1f97cc`; **environment manifest hash:** `f3075994b4a17608`
- **Noise band:** 1.75 (ratified; pilot spread 1.7126 — the band is the frozen formula's output over this spread; provenance, including any re-ratification, is in ratification.json)
- **Environment:** darwin 25.5.0 arm64, git git version 2.50.1 (Apple Git-155), gh gh version 2.95.0 (2026-06-17), Bun 1.4.0; network: operator macOS workstation (same host as the Step-B pilot); credential: PAT (gh auth) (login `rvobot`)

> **Scope, stated plainly (plan §4.6):** this is a per-scenario serial cost profile, not an
> estate simulation. Concurrent fan-out, the shared REST+GraphQL budget under contention,
> cross-unit cache effects, and aggregate clone disk remain design-ledger items; the
> concurrency probe below evidences them without scoring them.

## 1. Scores (§4.6)

`T(r) = min(3600 × files ÷ wall(r), capacity × files ÷ units(r) per consuming bucket)`;
score = median of T over K=5, worst-of-K beside it. `files` = the unit's full pinned
workload (read + no-read entries) — a per-unit constant, so within-unit ratios are unaffected.
Tree acquisition counts toward units (T0/T1 pay it; T2a/T2c do not); discovery is excluded.

### Median T (files/hour) at the pinned 5,000-point bucket

| Unit | T0 | T1 | T2a | T2c |
|---|---:|---:|---:|---:|
| C1:prometheus/prometheus@main | 4,980 (worst 4,980) | 119,885 (worst 91,850) | 587,750 (worst 402,821) | 606,839 (worst 496,268) |
| C1:prometheus/prometheus@release-3.13 | 4,980 (worst 4,980) | 114,061 (worst 92,343) | 449,865 (worst 321,513) | 624,751 (worst 514,448) |
| C1:prometheus/prometheus@release-3.12 | 4,980 (worst 4,980) | 140,409 (worst 86,116) | 495,568 (worst 402,189) | 527,203 (worst 498,895) |
| C1:prometheus/prometheus@release-3.11 | 4,981 (worst 4,981) | 97,210 (worst 95,991) | 552,703 (worst 422,052) | 632,550 (worst 548,606) |
| C2:nestjs/nest@master | 4,912 (worst 4,912) | 80,020 (worst 74,511) | 140,435 (worst 110,200) | 207,396 (worst 187,195) |
| C3:kubernetes/kubernetes@master | 4,986 (worst 4,971) | 101,467 (worst 87,070) | 4,986 (worst 4,986) | 139,680 (worst 139,542) |
| C4:llvm/llvm-project@main | 63,158 (worst 59,834) | 61,708 (worst 50,571) | 64,014 (worst 55,588) | 106,728 (worst 99,602) |
| C5:PowerShell/PowerShell@master | 4,815 (worst 4,815) | 61,912 (worst 44,290) | 27,568 (worst 26,837) | 36,657 (worst 34,498) |

### The same runs read off at a 15,000-point credential (median, worst-of-K beside it)

| Unit | T0 | T1 | T2a | T2c |
|---|---:|---:|---:|---:|
| C1:prometheus/prometheus@main | 10,509 (worst 9,621) | 119,885 (worst 91,850) | 587,750 (worst 402,821) | 606,839 (worst 496,268) |
| C1:prometheus/prometheus@release-3.13 | 10,453 (worst 10,226) | 114,061 (worst 92,343) | 449,865 (worst 321,513) | 624,751 (worst 514,448) |
| C1:prometheus/prometheus@release-3.12 | 10,231 (worst 9,885) | 140,409 (worst 86,116) | 495,568 (worst 402,189) | 527,203 (worst 498,895) |
| C1:prometheus/prometheus@release-3.11 | 10,454 (worst 10,245) | 97,210 (worst 95,991) | 552,703 (worst 422,052) | 632,550 (worst 548,606) |
| C2:nestjs/nest@master | 10,280 (worst 10,012) | 80,020 (worst 74,511) | 140,435 (worst 110,200) | 207,396 (worst 187,195) |
| C3:kubernetes/kubernetes@master | 10,578 (worst 9,622) | 101,467 (worst 87,070) | 10,572 (worst 10,122) | 139,680 (worst 139,542) |
| C4:llvm/llvm-project@main | 63,158 (worst 59,834) | 61,708 (worst 50,571) | 64,014 (worst 55,588) | 106,728 (worst 99,602) |
| C5:PowerShell/PowerShell@master | 9,499 (worst 9,353) | 61,912 (worst 44,290) | 27,568 (worst 26,837) | 36,657 (worst 34,498) |

### Per-run walls and consumption (median across K complete reps)

| Unit | Driver | Wall (median) | Core units | GraphQL units | Peak disk (max) | Fallback spend | HTTP bytes | Store bytes | Segments |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C1:prometheus/prometheus@main | T0 | 87.4 s | 256 | 0.0 | 6.2 MiB | 0.0 | 2.3 MiB | — | 1 |
| C1:prometheus/prometheus@main | T1 | 7657 ms | 1.0 | 3.0 | 619.4 KiB | 0.0 | 2.4 MiB | — | 1 |
| C1:prometheus/prometheus@main | T2a | 1562 ms | 0.0 | 0.0 | 34.0 MiB | 0.0 | 0 B | 6.1 MiB | 1 |
| C1:prometheus/prometheus@main | T2c | 1513 ms | 0.0 | 0.0 | 6.2 MiB | 0.0 | 0 B | 6.1 MiB | 1 |
| C1:prometheus/prometheus@release-3.13 | T0 | 86.4 s | 252 | 0.0 | 4.1 MiB | 0.0 | 2.3 MiB | — | 1 |
| C1:prometheus/prometheus@release-3.13 | T1 | 7922 ms | 1.0 | 3.0 | 611.4 KiB | 0.0 | 2.4 MiB | — | 1 |
| C1:prometheus/prometheus@release-3.13 | T2a | 2009 ms | 0.0 | 0.0 | 33.4 MiB | 0.0 | 0 B | 6.0 MiB | 1 |
| C1:prometheus/prometheus@release-3.13 | T2c | 1446 ms | 0.0 | 0.0 | 6.1 MiB | 0.0 | 0 B | 6.0 MiB | 1 |
| C1:prometheus/prometheus@release-3.12 | T0 | 88.0 s | 251 | 0.0 | 4.8 MiB | 0.0 | 2.8 MiB | — | 1 |
| C1:prometheus/prometheus@release-3.12 | T1 | 6410 ms | 2.0 | 3.0 | 1.5 MiB | 1.0 | 3.5 MiB | — | 1 |
| C1:prometheus/prometheus@release-3.12 | T2a | 1816 ms | 0.0 | 0.0 | 33.4 MiB | 0.0 | 0 B | 5.9 MiB | 1 |
| C1:prometheus/prometheus@release-3.12 | T2c | 1707 ms | 0.0 | 0.0 | 6.0 MiB | 0.0 | 0 B | 5.9 MiB | 1 |
| C1:prometheus/prometheus@release-3.11 | T0 | 88.9 s | 259 | 0.0 | 6.3 MiB | 0.0 | 2.8 MiB | — | 1 |
| C1:prometheus/prometheus@release-3.11 | T1 | 9555 ms | 2.0 | 3.0 | 1.5 MiB | 1.0 | 3.5 MiB | — | 1 |
| C1:prometheus/prometheus@release-3.11 | T2a | 1680 ms | 0.0 | 0.0 | 32.8 MiB | 0.0 | 0 B | 5.8 MiB | 1 |
| C1:prometheus/prometheus@release-3.11 | T2c | 1468 ms | 0.0 | 0.0 | 5.9 MiB | 0.0 | 0 B | 5.8 MiB | 1 |
| C2:nestjs/nest@master | T0 | 19.6 s | 57.0 | 0.0 | 1.6 MiB | 0.0 | 759.9 KiB | — | 1 |
| C2:nestjs/nest@master | T1 | 2519 ms | 1.0 | 1.0 | 820.6 KiB | 0.0 | 781.7 KiB | — | 1 |
| C2:nestjs/nest@master | T2a | 1436 ms | 0.0 | 0.0 | 7.1 MiB | 0.0 | 0 B | 1.4 MiB | 1 |
| C2:nestjs/nest@master | T2c | 972 ms | 0.0 | 0.0 | 1.5 MiB | 0.0 | 0 B | 1.4 MiB | 1 |
| C3:kubernetes/kubernetes@master | T0 | 118.4 s | 349 | 0.0 | 19.9 MiB | 0.0 | 11.8 MiB | — | 1 |
| C3:kubernetes/kubernetes@master | T1 | 12.3 s | 2.0 | 2.0 | 19.9 MiB | 1.0 | 11.9 MiB | — | 1 |
| C3:kubernetes/kubernetes@master | T2a | 118.5 s | 349 | 0.0 | 19.9 MiB | 0.0 | 11.8 MiB | — | 1 |
| C3:kubernetes/kubernetes@master | T2c | 8969 ms | 1.0 | 0.0 | 45.5 MiB | 1.0 | 15.7 KiB | 45.4 MiB | 1 |
| C4:llvm/llvm-project@main | T0 | 72.6 s | 1.0 | 0.0 | 2.44 GiB | 0.0 | 16.0 MiB | 293.1 MiB | 1 |
| C4:llvm/llvm-project@main | T1 | 74.3 s | 1.0 | 0.0 | 2.44 GiB | 0.0 | 16.0 MiB | 293.1 MiB | 1 |
| C4:llvm/llvm-project@main | T2a | 71.6 s | 0.0 | 0.0 | 2.41 GiB | 0.0 | 0 B | 293.1 MiB | 1 |
| C4:llvm/llvm-project@main | T2c | 43.0 s | 0.0 | 0.0 | 293.3 MiB | 0.0 | 0 B | 293.1 MiB | 1 |
| C5:PowerShell/PowerShell@master | T0 | 9854 ms | 27.0 | 0.0 | 1.4 MiB | 0.0 | 910.7 KiB | — | 1 |
| C5:PowerShell/PowerShell@master | T1 | 1512 ms | 1.0 | 1.0 | 957.4 KiB | 0.0 | 919.1 KiB | — | 1 |
| C5:PowerShell/PowerShell@master | T2a | 3395 ms | 0.0 | 0.0 | 56.3 MiB | 0.0 | 0 B | 11.1 MiB | 1 |
| C5:PowerShell/PowerShell@master | T2c | 2553 ms | 0.0 | 0.0 | 11.2 MiB | 0.0 | 0 B | 11.1 MiB | 1 |

HTTP body bytes (API drivers) and on-disk object-store bytes (clone drivers) are two
explicitly non-comparable transfer kinds (§4.6.3) — the store column is labelled on-disk
because git reports no clean transfer figure without packet tracing.

## 2. Eligibility (§4.7 G1–G4, global per driver)

| Driver | G1 fidelity | G2 completeness | G3 stability | G4 envelope | Attributable secondary signals | Eligible |
|---|---|---|---|---|---:|---|
| T0 | fail | pass | pass | fail | 0 | no |
| T1 | fail | pass | pass | fail | 0 | no |
| T2a | fail | pass | pass | fail | 0 | no |
| T2c | pass | pass | pass | pass | 0 | **yes** |

**T0** (disqualifying evidence):

- G4: sampled-peak disk 2620050734 B exceeds the 2147483648 B gate at pos 101 (outcome complete)
- G4: sampled-peak disk 2620387835 B exceeds the 2147483648 B gate at pos 107 (outcome complete)
- G4: sampled-peak disk 2620033020 B exceeds the 2147483648 B gate at pos 112 (outcome complete)
- G4: sampled-peak disk 2620387835 B exceeds the 2147483648 B gate at pos 114 (outcome complete)
- G4: sampled-peak disk 2620387835 B exceeds the 2147483648 B gate at pos 117 (outcome complete)
- G4: sampled-peak disk 2665818776 B exceeds the 2147483648 B gate at pos 166 (outcome complete)
- G1: fidelity battery fail-mismatch on non-utf8-content t/t4201-shortlog.sh

**T1** (disqualifying evidence):

- G4: sampled-peak disk 2620033020 B exceeds the 2147483648 B gate at pos 102 (outcome complete)
- G4: sampled-peak disk 2620029804 B exceeds the 2147483648 B gate at pos 105 (outcome complete)
- G4: sampled-peak disk 2620387835 B exceeds the 2147483648 B gate at pos 111 (outcome complete)
- G4: sampled-peak disk 2620029804 B exceeds the 2147483648 B gate at pos 116 (outcome complete)
- G4: sampled-peak disk 2620387835 B exceeds the 2147483648 B gate at pos 119 (outcome complete)
- G4: sampled-peak disk 2665467961 B exceeds the 2147483648 B gate at pos 167 (outcome invalidated-straddle)
- G4: sampled-peak disk 2665467961 B exceeds the 2147483648 B gate at pos 167 (outcome complete)
- G1: fidelity battery fail-mismatch on non-utf8-content t/t4201-shortlog.sh

**T2a** (disqualifying evidence):

- G4: sampled-peak disk 2586488979 B exceeds the 2147483648 B gate at pos 104 (outcome complete)
- G4: sampled-peak disk 2586488979 B exceeds the 2147483648 B gate at pos 106 (outcome complete)
- G4: sampled-peak disk 2586488979 B exceeds the 2147483648 B gate at pos 109 (outcome complete)
- G4: sampled-peak disk 2586488979 B exceeds the 2147483648 B gate at pos 115 (outcome complete)
- G4: sampled-peak disk 2586130948 B exceeds the 2147483648 B gate at pos 118 (outcome complete)
- G1: 255 delivery-fidelity failure(s) at pos 161 (C1:prometheus/prometheus@main rep 6, outcome complete)
- G1: 13 delivery-fidelity failure(s) at pos 162 (C5:PowerShell/PowerShell@master rep 6, outcome complete)
- G1: 258 delivery-fidelity failure(s) at pos 163 (C1:prometheus/prometheus@release-3.11 rep 6, outcome complete)
- G1: 250 delivery-fidelity failure(s) at pos 165 (C1:prometheus/prometheus@release-3.12 rep 6, outcome complete)
- G1: 1260 delivery-fidelity failure(s) at pos 168 (C4:llvm/llvm-project@main rep 6, outcome complete)
- G4: sampled-peak disk 2631561889 B exceeds the 2147483648 B gate at pos 168 (outcome complete)
- G1: 55 delivery-fidelity failure(s) at pos 169 (C2:nestjs/nest@master rep 6, outcome complete)
- G1: 251 delivery-fidelity failure(s) at pos 170 (C1:prometheus/prometheus@release-3.13 rep 6, outcome complete)

### Checkout-config probe divergences (first-class findings, §4.7 G1)

Divergences on declared-caveat routes are recorded findings for the decision-maker, not
auto-disqualifications (the waiver is exactly the config delta; §4.7 G1):

- T0 on C4:llvm/llvm-project@main (pos 166): 1260 diverging deliveries under `autocrlf=true`
- T1 on C4:llvm/llvm-project@main (pos 167): 1260 diverging deliveries under `autocrlf=true`
- T1 on C4:llvm/llvm-project@main (pos 167): 1260 diverging deliveries under `autocrlf=true`

### C6 fidelity battery

| Fixture | Driver | Entry | Final state |
|---|---|---|---|
| api-only-symlink | T0 | `deps/v8/third_party/ittapi/ittapi-rs/CMakeLists.txt` | pass |
| api-only-symlink | T1 | `deps/v8/third_party/ittapi/ittapi-rs/CMakeLists.txt` | pass |
| clone-symlink | T0 | `.azure-pipelines/commands/alpine.sh` | pass |
| clone-symlink | T1 | `.azure-pipelines/commands/alpine.sh` | pass |
| clone-symlink | T2a | `.azure-pipelines/commands/alpine.sh` | pass |
| clone-symlink | T2c | `.azure-pipelines/commands/alpine.sh` | pass |
| non-utf8-content | T0 | `t/t4201-shortlog.sh` | fail-mismatch |
| non-utf8-content | T1 | `t/t4201-shortlog.sh` | fail-mismatch |
| non-utf8-content | T2a | `t/t4201-shortlog.sh` | pass |
| non-utf8-content | T2c | `t/t4201-shortlog.sh` | pass |

## 3. Comparison under the 1.75 band and the §4.7 rule's output

Eligible drivers: T2c.

### Rule output (§4.7 case mapping, exhaustive)

**Exactly one eligible driver.** The rule recommends **T2c**, with every other
driver's disqualifying evidence attached in §2 above.

The Step-D decision — ratify or override, in any direction — is a separate PR and passes one
further adversarial review round before ADR-0001 changes state (§4.7). An ineligible driver
can never be chosen.

## 4. Protocol events (§4.5 taxonomy census)

| Event | Count |
|---|---:|
| R1/R2 driver rerun allowances consumed | 0 |
| R3 foreign-consumption invalidations | 0 |
| R4 reset-window straddles | 2 |
| Control-plane invalidations (snapshot failures) | 0 |
| R6 branch-arm drift restarts (scaffolding epilogue) | 0 |
| Epilogue rows executed | 0 |
| Segmented runs (§4.8 feasibility gate) | 0 |

Failed and invalidated attempts stay in `runs.jsonl` and count in failure metrics; a
replaced attempt's timing is excluded from throughput aggregation and the replay's enters
(§4.5). Git transport pacing stayed well under 15 ops/s/repo by construction: each run
issues at most a handful of git transport operations (acquire, coherence check, enumerate,
one interactive read child) per run — even the fastest sub-second wall carries only that
handful of operations, far under the ceiling (§4.8, asserted here).

## 5. Informational executors (reported, not scored)

### Boundary probe (§4.4)

Committed as [boundary-probe.json](boundary-probe.json). Cells: alias counts
{250, 300, 350, 400, 425, 450, 475} at small fixed content, plus alias×content
{150, 250} × {1.5 MiB, 3 MiB}, 3 tries per cell, on nestjs/nest.

| Aliases | Content target | Actual bytes | Try outcomes (status/classification) |
|---:|---:|---:|---|
| 250 | small | 18.8 KiB | 200/ok, 200/ok, 200/ok |
| 300 | small | 26.0 KiB | 200/ok, 200/ok, 200/ok |
| 350 | small | 34.0 KiB | 200/ok, 200/ok, 200/ok |
| 400 | small | 43.0 KiB | 200/ok, 200/ok, 200/ok |
| 425 | small | 47.8 KiB | 200/ok, 200/ok, 200/ok |
| 450 | small | 52.8 KiB | 200/ok, 200/ok, 200/ok |
| 475 | small | 58.1 KiB | 200/ok, 200/ok, 200/ok |
| 150 | 1.5 MiB | 1.3 MiB | 200/ok, 200/ok, 200/ok |
| 150 | 3.0 MiB | 1.8 MiB | 200/ok, 200/ok, 200/ok |
| 250 | 1.5 MiB | 1.2 MiB | 200/ok, 200/ok, 200/ok |
| 250 | 3.0 MiB | 1.9 MiB | 200/ok, 200/ok, 200/ok |

### Concurrency probe (§4.5)

Committed as [concurrency-probe.json](concurrency-probe.json): C1's four branch
units as 4 concurrent streams, for T0 and for T1, every secondary-limit signal recorded.

| Driver | Streams complete | Wall range | Secondary signals | 5xx | Retries |
|---|---|---|---:|---:|---:|
| T0 | 4/4 | 80.1 s–84.5 s | 0 | 0 | 0 |
| T1 | 4/4 | 8097 ms–9447 ms | 0 | 0 | 0 |

These results evidence the scheduler requirement; they rank nothing (§4.5).

### Option 3 (compositional analysis, §4.4)

Committed as [option3.json](option3.json): the offline duplicate-OID analysis over
the corpus trees plus the frozen warm-run scenario
(base/advanced = the pinned warm-pair SHAs recorded in corpus.json).

> OID-keyed content caching composes with the API read paths (T0/T1): a cache hit skips a REST request or shrinks a GraphQL batch, which is exactly what the warm legs measure. On the clone paths (T2a/T2c) the unit's cost is dominated by whole-branch pack transfer, which an OID-keyed CONTENT cache does not reduce — a warm T2c leg still clones the branch and saves only local cat-file reads (microseconds each). What git natively provides in this direction is incremental object transfer against a PERSISTED prior store (fetch negotiation); production's fresh-clone-per-unit design has no persisted store, so that reuse is a different architecture (a shared object store), not a cache layer over the measured drivers.

## 6. Review record

Step B's harness passed its adversarial review rounds (the counts and outcomes are
committed in ratification.json's adversarialReviewRecord and amendment entries; no formal
CONVERGED verdict was recorded — stated plainly, per the loop's own precedent). Step C's
runner repairs and executors passed the §8-amended review round
recorded in ratification.json before any evidence here was collected. The artifacts map:
`runs.jsonl` (§4.5/§4.6 matrix evidence), `fidelity.jsonl` (§4.2 battery),
`boundary-probe.json`/`concurrency-probe.json`/`option3.json` (§4.4/§4.5 informational),
this report (§4.6 metrics, §4.7 verdicts and rule output).

