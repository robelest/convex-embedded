# Benchmarks

Throughput + latency for the offline-first runtime.

## Why these exist

This package is the runtime for **offline-first Convex apps** — bounded,
single-user/small-team workspaces where the offline experience has to feel
instant. The measures that matter are **throughput (ops/sec)** and **latency
(p50/p99)** on the local path, at the top of realistic offline scope (~10k–50k
docs).

Two things make this profile specific, so the numbers are synthesized for it
rather than copied from other engines:

- **Bread-and-butter is CRDT merge + component storage** — reconciling state
  that diverged while offline and materializing merged docs. Those are Tier 1.
- **Every local read/write runs real JavaScript compute** through the UDF
  executor (`EmbeddedRuntime.executeLocal` → `executor.executeMutation/Query`),
  against real indexed SQLite. There is no in-memory dataflow shortcut, so
  latency is measured end-to-end through the real runtime.

## Running

```bash
vp run --filter benchmarks bench          # all suites
vp run --filter benchmarks bench:crdt     # one suite (crdt|component|compute|
                                          # queries|reactivity|storage|platform|remote)
vp run --filter benchmarks profile        # OTel span breakdown (see Profiling)
vp exec vitest bench --run --outputJson=/tmp/bench.json   # machine-readable
```

`bench` reports `hz` (throughput) and latency percentiles per row. Dataset
construction runs in `setup`/top-level and is excluded from timing; only the hot
path is measured.

## What each suite measures

| Suite | Tier | Backing | Volume |
| --- | --- | --- | --- |
| `crdt` | 1 | real Yjs + `@embedded/shared/yjs` merge | batches of 200/1000 docs; 2000-edit histories |
| `component` | 1 | real handler logic over in-memory mock `ctx.db` | 1k-deep tail; 10k-doc collection; 1000 live states |
| `compute` | 2 | real JS compute over file-backed indexed SQLite | 10k-doc table (separate runtimes for writes vs reads) |
| `queries` | 2 | real indexed SQLite query engine | 10k-doc table |
| `reactivity` | 2 | `SubscriptionManager` / `SyncProtocolHandler` | 10k held subscriptions |
| `storage` | 3 | real SQLite + blob adapter (better-sqlite3) | 5k-row inserts; 64 KB / 1 MB blobs |
| `platform` | — | UDF executor + system fns (mock modules) | 5k subs; 1k id-map/pending |
| `remote` | — | resolve engine (mock remote client) | 5 tables; 1k docs |

## Results

Captured 2026-05-24 on Apple M4, 24 GB, macOS (arm64), Node v24.15.0,
better-sqlite3 11.10.0, from a single `vitest bench` run. SQLite suites are
**file-backed** (on-disk temp DBs, not `:memory:`), matching production
persistence. `ops/sec` is throughput (higher is better); `p50`/`p99` are per-op
latency in ms (lower is better).

### Tier 1 — CRDT merge (offline reconciliation)

| Workload | Volume | ops/sec | p50 (ms) | p99 (ms) |
| --- | --- | ---: | ---: | ---: |
| offline reconcile merge batch | 200 docs | 111 | 9.06 | 9.45 |
| offline reconcile merge batch | 1,000 docs | 22 | 44.80 | 45.60 |
| materializeDocumentFromUpdate (live-state read) | 500 docs | 45 | 19.17 | 77.54 |
| raw Yjs apply heavily-edited history | 2,000 edits | 327 | 3.02 | 3.36 |
| raw Yjs mergeUpdates heavily-edited history | 2,000 edits | 36 | 27.69 | 28.47 |
| raw Yjs apply compacted snapshot | 2,000 edits | 3,717 | 0.26 | 0.52 |

A 200-doc reconcile batch is ~22k doc-merges/sec at ~9 ms p50. Applying a
compacted snapshot is ~14× faster than replaying the update log — the reason the
component store keeps compacted snapshots.

### Tier 1 — Component storage

| Workload | Volume | ops/sec | p50 (ms) | p99 (ms) |
| --- | --- | ---: | ---: | ---: |
| recordUpdate fresh doc (single delta append) | 1 doc | 26,827 | 0.036 | 0.046 |
| recordUpdate hot doc, retained tail | 1,000-deep tail | 1,010 | 0.94 | 1.93 |
| recordUpdate across collection | 10,000 docs | 333 | 2.93 | 4.25 |
| getLiveStates † | 1,000 docs | 12 | 80.94 | 82.48 |

These exercise the real handler logic (Yjs delta encode + tail management) over
an in-memory mock `ctx.db` to isolate compute from storage. † `getLiveStates` is
dominated by the mock's linear scans, not the handler (on real indexed SQLite it
is M point-lookups) — it is not a storage-representative number.

### Tier 2 — Local compute (real JS over indexed SQLite, 10k-doc table)

| Workload | ops/sec | p50 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: |
| executeLocal mutation insert | 6,789 | 0.116 | 1.98 |
| executeLocal mutation insert + applyLocalEffects | 6,466 | 0.121 | 2.01 |
| executeLocal query indexed range by_status (collect ~2.5k) | 77 | 12.11 | 40.07 |
| executeLocal query indexed range + take 20 | 620 | 1.57 | 2.28 |
| executeLocal query full scan + filter (contrast) | 69 | 14.52 | 15.08 |

A local write goes through the full real path (handler → db write → incremental
index maintenance → commit → async persist) at **~0.12 ms p50** — see
[Optimizations](#optimizations--fixes-from-stress-testing); this was ~38 ms
before the index path was rewritten. A bounded paginated read (`take 20`) is the
instant-read case at ~1.6 ms p50; a full collect over the matching ~2.5k rows
costs more because it materializes every row. (The write and read benches use
separate seeded runtimes so the fast writes don't grow the table the reads
measure.)

### Tier 2 — Query engine (real indexed SQLite, 10k docs)

| Workload | ops/sec | p50 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: |
| indexed range Eq(status=active) | 520 | 1.85 | 2.89 |
| indexed range Eq(assignee) | 692 | 1.34 | 2.70 |
| indexed range Gte(priority>=8) | 595 | 1.65 | 2.09 |
| indexed range + take 20 (paginate) | 765 | 1.29 | 1.90 |
| full table scan + filter (contrast) | 269 | 3.73 | 4.30 |

Indexed paginate is ~2.8× the throughput of a full scan, confirming index
selection works on the real engine.

### Tier 2 — Reactivity

| Workload | Volume | ops/sec | p50 (ms) | p99 (ms) |
| --- | --- | ---: | ---: | ---: |
| subscription invalidate by table | 10k subs | 3,263 | 0.27 | 1.41 |
| subscription invalidate dependency-aware | 10k subs | 1,133 | 0.85 | 1.25 |
| protocol reEvaluateQueries | 10k held subs | 88 | 11.19 | 21.43 |
| protocol mutation handling | 10k active queries | 92 | 10.47 | 15.63 |

### Tier 3 — Storage substrate (better-sqlite3, file-backed)

| Workload | Size | ops/sec | p50 (ms) | p99 (ms) |
| --- | --- | ---: | ---: | ---: |
| sqlite bulk insert ×5000 (indexed, batched commit) | 5k rows/op | 4 | 186.91 | 649.09 |
| blob putBlob | 64 KB | 7,130 | 0.080 | 2.58 |
| blob putBlob | 1 MB | 387 | 0.89 | 14.85 |
| blob getBlob | 64 KB | 37,749 | 0.021 | 0.081 |
| blob getBlob | 1 MB | 3,792 | 0.22 | 0.86 |
| blob put+delete churn | 64 KB | 8,788 | 0.082 | 0.89 |

Bulk insert is ~4 batches/sec × 5,000 rows ≈ 20k indexed row-writes/sec (high
variance, dominated by fsync).

### Platform primitives

| Workload | Volume | ops/sec | p50 (ms) | p99 (ms) |
| --- | --- | ---: | ---: | ---: |
| udf executor query invocation | mock module | 513,362 | 0.002 | 0.003 |
| udf executor mutation invocation | mock module | 349,379 | 0.002 | 0.009 |
| udf executor action invocation | mock module | 497,414 | 0.002 | 0.003 |
| system executeLocal query idMapGet | 1k id-map | 21,693 | 0.043 | 0.088 |
| system executeLocal mutation idMapSet update | 1k id-map | 11,406 | 0.085 | 0.140 |
| system executeLocal query pendingGetAll | 1k pending | 8,499 | 0.114 | 0.196 |
| scheduler schedule + cancel | — | 3,791,744 | <0.001 | <0.001 |
| subscription invalidate by table | 5k subs | 7,958 | 0.124 | 0.151 |
| subscription invalidate dependency-aware | 5k subs | 2,372 | 0.416 | 0.557 |
| runtime executeLocal query authStateGetActive | — | 1,701,643 | 0.001 | 0.001 |

UDF executor rows use mock modules — they measure executor dispatch overhead,
not handler work (the real-handler cost is in the Tier-2 `compute` suite).

### Remote engine

| Workload | Volume | ops/sec | p50 (ms) | p99 (ms) |
| --- | --- | ---: | ---: | ---: |
| resolve cycle across 5 tables | mock remote | 124 | 7.87 | 16.01 |
| stale remote snapshot after local delete | 1k docs | 75 | 13.26 | 18.73 |

## Profiling (where the time goes)

`vp run --filter benchmarks profile` installs the runtime's in-memory OpenTelemetry
exporter (`installInMemoryTracing`), runs a mutation + query workload through the
real hot path, and prints a per-span breakdown. The runtime emits spans on
`executeLocal.mutation` / `executeLocal.query`, `db.commit`, and
`db.applyIndexChanges`, so you can see the cost split without ad-hoc timers:

```
span                                     count   mean    p50    p99
executeLocal.mutation                      300  0.145  0.119  1.988
  db.commit                                300  0.051  0.047  0.101
    db.applyIndexChanges                   300  0.045  0.041  0.091
executeLocal.query (take 20)               300  1.686  1.676  2.052
```

This breakdown is what drove the optimizations below — it showed the mutation
cost was almost entirely index maintenance, then (after the fix) that index
maintenance is now a third of an already-tiny mutation. Spans are noop when no
tracer is installed, so the regular `bench` numbers are unaffected.

## Optimizations & fixes from stress testing

Running these at offline-ceiling volumes, with the OTel breakdown above,
surfaced and fixed the following:

- **Local write path: ~38 ms → ~0.12 ms p50 at 10k (~300×).** Two rounds:
  (1) every commit used to full-sort the whole table's in-memory indexes
  (O(n log n)); the SQL commit path now maintains them incrementally. (2) the
  incremental path still ran an O(n) `Set`-build duplicate scan **per index, per
  commit** — the OTel breakdown showed that was ~95% of the mutation. Since index
  keys end in `_id` (unique), a duplicate insert always lands adjacent to its
  existing entry, so the check is now O(1) at insert time. Index maintenance
  dropped 2.37 ms → 0.045 ms at 10k. (An O(log n) tree was considered but the
  splice is now negligible, so it isn't worth the rewrite.)
- **O(n²) in offline reference hydration** — `engine.ts` `hydrateDocumentsById`
  filtered the whole table with `ids.includes()` per doc; now a `Set` (O(n)).
- **Per-query index-definition allocation** — `_getIndexDefinitions` rebuilt its
  array on every call (several per query); now memoized per table (the schema is
  immutable after construction).
- **Full-table reads overflowed past ~128k rows** — `getAllDocuments` /
  `getDocumentsByTables` / store refresh spread an entire table into
  `Array.prototype.push(...rows)`, throwing `RangeError` once a table exceeded the
  engine's spread-arg limit (lower on JSC/Hermes). Now they append in a loop.
- **Document ids collided under rapid same-millisecond mutations** — the UDF
  deterministic PRNG was seeded from `Date.now()`; the default seed now mixes in
  a per-invocation counter. (Latent before the write-path speedup made same-ms
  mutations common.)

## What these numbers do and don't show

- **Tier 1 CRDT** and **Tier 2 compute/queries/storage** are the
  representative, real-path numbers.
- **Component** and **platform UDF executor** rows use a mock store / mock
  modules to isolate logic; treat them as logic throughput, not storage figures.
- There is **no CI regression gate** yet. These are a recorded baseline; gating
  becomes relevant at release and when swapping SQLite → Turso. Re-run on the
  same machine to compare. (The aggregate `bench` run occasionally exits non-zero
  from a vitest teardown race across the 8 modules; per-suite runs are clean and
  the results/JSON are unaffected.)
