# R3-P03: Bounded Frequency Recoloring

Date: 2026-10-24
Base: `e223536`
Worktree: `data/runtime/collab/wt/p3-interference`

## Scope

Only these files belong to this change:

- `scripts/planning/frequency.py`
- `tests/test_frequency_preferences.py`
- `docs/design/parallel/R3-P03-frequency.md`

No main-checkout source edits, database writes, services, dependency copies, or
full DEM planning runs were performed. The existing main `.venv` was reused.
This change does not modify an HTTP contract, resource table, threshold, pool,
bandwidth, topology, device binding, guard interval, port limit, or relay rule.
Main owns `actual_search.py` and `sr4_flow.py` integration and physical checking.

## Behavior

The preference repair now follows the insertion order of `channel_preference`.
This preserves the failure-weight priority supplied by `ChannelSearch`.
Each target must strictly improve its own rank. Every already-processed target
must retain or improve its rank, including a target that was already satisfied.
Only members of each task's actual `allowed` list can be selected. Unknown,
disabled, excluded, and out-of-range preference IDs cannot add candidates.

Recursive displacement supports several blockers and cycles of three or more
nets. Previously placed nets and explicit manual assignments cannot be ejected.
An unscored blocker prefers a channel released by the current displacement
before unrelated channels. This limits incidental movement where possible;
it does not establish physical suitability of that replacement channel.

Default limits are eight nets per attempted replacement, 6,000 checkpoints
across the entire repair call, and a 0.5-second monotonic deadline. Failure or
exhaustion discards the incomplete trial and retains earlier completed moves.
Every accepted trial is checked with the existing co-channel and adjacent-guard
rules and cannot increase the number of conflicts. Existing assignments are
never omitted to conceal a conflict. The caller's color map and allowed lists
are not mutated.

`assign()`'s signature, default execution path, explicit manual semantics, and
result schema are unchanged. The helper runs only with nonempty preferences.

## Verification

Executed in this worktree using the existing main interpreter:

```powershell
& F:/work/project2026-1/.venv/Scripts/python.exe -B -m pytest -p no:cacheprovider tests/test_frequency_preferences.py tests/test_sr4_actual_search.py -q
```

Result: **45 passed** (2.62 seconds).

Coverage includes a forced three-net cycle with incompatible direct swaps,
multiple co-channel and adjacent-channel blockers, caller priority order,
earlier-rank preservation, fixed blockers at several recursion depths, released
channel reuse, region/step/deadline exhaustion, completed-move retention,
unavoidable conflicts, authoritative manual and pool constraints, unchanged
default dispatch, and 40 fixed-seed small-graph invariant cases.

A separate read-only comparison on the frozen M3 topology found exact result
equality between the main allocator and this allocator for both default calls
and explicit manual calls without preferences. Main `frequency.py` still
matched the M3 manifest SHA-256 during the final diagnostic.

## Actual Physical Findings

Evidence input:
`data/runtime/r3-m3-real-fixed-1792814084621/{algorithm-input,result,summary}.json`.
Native `DemTerrain`, bound physical devices, existing maximum power levels,
native bandwidths, external interference rows, and constrained frozen frequency
rows were used. Demand overrides must be merged with frozen communication rows
to obtain all 410 demands and 89 mandatory demands.

The ten M3 shortfalls are five primary uplinks and five optional edges:

| Link | Endpoints | Primary | M3 Margin dB |
|---|---|---|---:|
| OL-0043 | ND-0096 / ND-0042 | Yes | -51.729931 |
| OL-0095 | ND-0022 / ND-0005 | Yes | 3.085515 |
| OL-0098 | ND-0005 / ND-0001 | Yes | -2.335738 |
| OL-0099 | ND-0006 / ND-0001 | Yes | -9.447800 |
| OL-0129 | CS-III-CS-0937 / ND-0041 | Yes | 5.734982 |
| OL-0147 | CS-III-CS-0712 / ND-0009 | No | 0.866058 |
| OL-0148 | CS-III-CS-0712 / ND-0013 | No | -0.962625 |
| OL-0158 | CS-III-CS-0108 / ND-0017 | No | 2.567600 |
| OL-0161 | ND-0013 / ND-0049 | No | 4.343986 |
| OL-0165 | CS-III-CS-0108 / ND-0033 | No | 2.578293 |

Scanning all legal channels at native maximum power and frozen heights showed:

- OL-0043's best margin is -21.697082 dB; recoloring cannot repair this binding.
- Each of the five optional failures remains below 6 dB on every legal channel.
- The root HF net has 14 channels where all four members exceed 6 dB. Its best
  minimum is 18.550798 dB at FQ-0024 / 7500 kHz.
- OL-0095 reaches 28.996794 dB at FQ-0024 / 7500 kHz.
- OL-0129 has one passing channel, FQ-0099 / 467943.1 kHz, at 6.014018 dB.

The final recolorer was also applied in memory to the frozen M3 coloring, using
the native preferences in their original priority order. This is an isolated
recoloring preview, not a fresh `assign()` / power / topology planning run.
It took approximately 32 ms, accepted six replacements, moved 25 distinct nets,
and retained zero frequency conflicts. It restored:

| Link | Selected kHz | Native Margin dB |
|---|---:|---:|
| OL-0095 | 7500.0 | 28.996794 |
| OL-0098 | 7108.7 | 17.724152 |
| OL-0099 | 7108.7 | 18.012044 |
| OL-0129 | 467943.1 | 6.014018 |

**This preview is physically unacceptable overall.** At frozen powers it
introduces OL-0008, OL-0015, OL-0016, OL-0087, and OL-0153 shortfalls. Independent
metrics on the resulting physical graph are connectivity 0.7756, mandatory
connectivity 0.8090, and survivability 0.7303. The first three and OL-0153 still
fail at maximum power; OL-0087 can recover at maximum power. With only HF
preferences, the three HF targets recover without a frequency conflict but
OL-0153 still newly fails at -14.691138 dB even at maximum power.

Main must retain its complete native physical validation and reject these
regressions. A follow-up candidate can give displaced healthy nets native
physical preference lists, or explore bounded preference subsets / alternate
legal channels before accepting a replacement. Frequency legality alone does
not preserve survivability, primary-link margins, or mandatory connectivity.
No 90% acceptance claim is made by this change.

For the older PL-CFB24DAB topology, the exact frozen 14-net / 13-channel VUHF
clique was independently reproduced, including NET-ND-0009-VUHF and
NET-ND-0028-VUHF at the residual same-frequency conflict. Another subset has
15 nets / 14 channels. Recoloring cannot eliminate those fixed-topology resource
deficits; M3's changed topology already has zero frequency conflicts.
