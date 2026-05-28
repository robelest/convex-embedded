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

| Suite         | Tier | Backing                                          | Volume                                                |
| ------------- | ---- | ------------------------------------------------ | ----------------------------------------------------- |
| `crdt`        | 1    | real Yjs + `@embedded/shared/yjs` merge          | batches of 200/1000 docs; 2000-edit histories         |
| `component`   | 1    | real handler logic over in-memory mock `ctx.db`  | 1k-deep tail; 10k-doc collection; 1000 live states    |
| `compute`     | 2    | real JS compute over file-backed indexed SQLite  | 10k-doc table (separate runtimes for writes vs reads) |
| `queries`     | 2    | real indexed SQLite query engine                 | 10k-doc table                                         |
| `pagination`  | 2    | real indexed SQLite `paginate()` cursor walk     | 10k-doc table (~2.5k-row range)                       |
| `searchcache` | 2    | engine search/vector index build (cache vs cold) | 10k-doc table                                         |
| `reactivity`  | 2    | `SubscriptionManager` / `SyncProtocolHandler`    | 10k held subscriptions                                |
| `storage`     | 3    | real SQLite + blob adapter (better-sqlite3)      | 5k-row inserts; 64 KB / 1 MB blobs                    |
| `platform`    | —    | UDF executor + system fns (mock modules)         | 5k subs; 1k id-map/pending                            |
| `remote`      | —    | resolve engine (mock remote client)              | 5 tables; 1k docs                                     |

## Results

Captured 2026-05-24 on Apple M4, 24 GB, macOS (arm64), Node v24.15.0,
better-sqlite3 11.10.0, from a single `vitest bench` run. SQLite suites are
**file-backed** (on-disk temp DBs, not `:memory:`), matching production
persistence. `ops/sec` is throughput (higher is better); `p50`/`p99` are per-op
latency in ms (lower is better).

### Tier 1 — CRDT merge (offline reconciliation)

| Workload                                        | Volume      | ops/sec | p50 (ms) | p99 (ms) |
| ----------------------------------------------- | ----------- | ------: | -------: | -------: |
| offline reconcile merge batch                   | 200 docs    |     109 |     9.19 |     9.59 |
| offline reconcile merge batch                   | 1,000 docs  |      22 |    45.05 |    45.85 |
| materializeDocumentFromUpdate (live-state read) | 500 docs    |      52 |    19.27 |    77.94 |
| raw Yjs apply heavily-edited history            | 2,000 edits |     288 |     3.48 |     3.87 |
| raw Yjs mergeUpdates heavily-edited history     | 2,000 edits |      35 |    28.25 |    29.05 |
| raw Yjs apply compacted snapshot                | 2,000 edits |   3,811 |     0.26 |     0.52 |

A 200-doc reconcile batch is ~22k doc-merges/sec at ~9 ms p50. Applying a
compacted snapshot is ~14× faster than replaying the update log — the reason the
component store keeps compacted snapshots.

### Tier 1 — Component storage

| Workload                                     | Volume          | ops/sec | p50 (ms) | p99 (ms) |
| -------------------------------------------- | --------------- | ------: | -------: | -------: |
| recordUpdate fresh doc (single delta append) | 1 doc           |  25,428 |    0.039 |    0.049 |
| recordUpdate hot doc, retained tail          | 1,000-deep tail |   1,050 |     0.95 |     1.95 |
| recordUpdate across collection               | 10,000 docs     |     334 |     2.99 |     4.31 |
| getLiveStates †                              | 1,000 docs      |      12 |    85.47 |    87.01 |

These exercise the real handler logic (Yjs delta encode + tail management) over
an in-memory mock `ctx.db` to isolate compute from storage. † `getLiveStates` is
dominated by the mock's linear scans, not the handler (on real indexed SQLite it
is M point-lookups) — it is not a storage-representative number.

### Tier 2 — Local compute (real JS over indexed SQLite, 10k-doc table)

| Workload                                                   | ops/sec | p50 (ms) | p99 (ms) |
| ---------------------------------------------------------- | ------: | -------: | -------: |
| executeLocal mutation insert                               |   7,175 |    0.139 |     1.98 |
| executeLocal mutation insert + applyLocalEffects           |   6,693 |    0.149 |     2.01 |
| executeLocal query indexed range by_status (collect ~2.5k) |      69 |    14.47 |    40.07 |
| executeLocal query indexed range + take 20                 |   6,554 |    0.153 |     0.22 |
| executeLocal query full scan + filter (contrast)           |      71 |    14.04 |    14.60 |

A local write goes through the full real path (handler → db write → incremental
index maintenance → commit → async persist) at **~0.14 ms p50** — see
[Optimizations](#optimizations--fixes-from-stress-testing); this was ~38 ms
before the index path was rewritten. A bounded paginated read (`take 20`) is the
instant-read case at ~0.15 ms p50; a full collect over the matching ~2.5k rows
costs more because it materializes every row. (The write and read benches use
separate seeded runtimes so the fast writes don't grow the table the reads
measure.)

### Tier 2 — Query engine (real indexed SQLite, 10k docs)

| Workload                              | ops/sec | p50 (ms) | p99 (ms) |
| ------------------------------------- | ------: | -------: | -------: |
| indexed range Eq(status=active)       |     553 |     1.81 |     6.16 |
| indexed range Eq(assignee)            |     540 |     1.85 |     3.48 |
| indexed range Gte(priority>=8)        |     403 |     2.48 |     4.61 |
| indexed range + take 20 (paginate)    |     704 |     1.42 |     2.66 |
| full scan + take 20 + filter(=7) sel. |     677 |     1.48 |     2.32 |
| full table scan + filter (contrast)   |     241 |     4.16 |     4.64 |

Indexed paginate is ~2.9× the throughput of a full scan, confirming index
selection works on the real engine. The selective `take(20).filter(...)` case
runs at full-paginate speed (~2.8× the unbounded scan) because the read stops at
the limit instead of scanning the whole table.

### Tier 2 — Bounded `take/first/unique` + `.filter()` on the engine source path

When a filter cannot be pushed down to SQLite (e.g. arithmetic like
`priority % 9 == 7`), the query falls back to the engine's source reader. The
engine now streams the source in a doubling window and stops once
`take`/`first`/ `unique` has enough survivors, instead of reading the whole
table then slicing. Measured on a non-hydrated 10k-doc SQLite DB so reads stream
through the source reader:

| Workload                                 | ops/sec | p50 (ms) | p99 (ms) |
| ---------------------------------------- | ------: | -------: | -------: |
| take 20 + filter(priority%9==7) — before |    79.8 |    12.53 |    13.12 |
| take 20 + filter(priority%9==7) — after  |   526.3 |     1.90 |     2.11 |
| filter(priority%9==7) collect (contrast) |    50.5 |    19.80 |    20.10 |

The bounded read is ~6.6× faster than before and its cost tracks the position of
the matches, not the table size (the unbounded `collect` contrast still scans
all 10k rows). On filters that SQLite _can_ push down (`take(20).filter(=)` over
the same data), the pushdown path already bounds the read and runs at ~677
ops/sec — ~13× the unbounded collect — independent of this engine-side change.

### Tier 2 — Pagination (cursor-based `paginate()`, real indexed SQLite, 10k docs)

| Workload                                     | ops/sec | p50 (ms) | p99 (ms) |
| -------------------------------------------- | ------: | -------: | -------: |
| first page — indexed Eq(status), pageSize=50 |  70,381 |    0.014 |    0.018 |
| first page — full table scan, pageSize=50    |   9,290 |    0.108 |    0.169 |
| paginate entire indexed range, pageSize=100  |     316 |     3.17 |     4.46 |

`paginate()` is a bounded **index seek**: the cursor encodes the order-key of
the last row, and resuming a page seeks the index (`> cursor`) and reads only
`pageSize` rows — O(pageSize) per page, flat regardless of depth. A first page
is ~0.014 ms; walking the entire ~2.5k-row range in 100-row pages is ~3.2 ms
(~0.13 ms per page), on par with a single full drain of the same rows. Earlier
this rescanned the whole result set on every page (first page ~1.6 ms, full walk
~43 ms, O(n²)); see [Optimizations](#optimizations--fixes-from-stress-testing).
Each call emits a `convex-embedded.db.paginate` span (page size, rows returned,
`isDone`) so pagination shows up in the OTel profiler alongside queries and
mutations.

### Tier 2 — Search / vector index cache (engine fallback, 10k docs)

| Workload                            | ops/sec | p50 (ms) | p99 (ms) |
| ----------------------------------- | ------: | -------: | -------: |
| search — cache warm (reuse index)   |     473 |    2.115 |    5.010 |
| search — rebuild per query (before) |      28 |   35.714 |   46.600 |
| vector — cache warm (reuse index)   |   3,882 |    0.258 |    0.339 |
| vector — rebuild per query (before) |     237 |    4.216 |   16.910 |

The engine's search/vector fallback (`_evaluateSearchSource` / `vectorSearch`,
used when no materialized index state exists) previously rebuilt the full-text /
vector index from **all** rows on **every** query — O(table) per call. The build
is now cached per `(table, index)` keyed by the table's version
(`getTableVersion`, bumped on every committed write), so identical searches with
no intervening write reuse the built index and any write invalidates it. On the
10k-doc table this is **~16.9× faster** for search (28 → 473 ops/sec) and
**~16.4× faster** for vector (237 → 3,882 ops/sec) once the cache is warm;
per-query cost no longer scales with table size. The "before" columns are
measured by bumping the version on each call to force the old
rebuild-every-query behavior.

### Tier 2 — Reactivity

| Workload                                 | Volume             | ops/sec | p50 (ms) | p99 (ms) |
| ---------------------------------------- | ------------------ | ------: | -------: | -------: |
| subscription invalidate by table         | 10k subs           |   3,460 |     0.29 |     1.50 |
| subscription invalidate dependency-aware | 10k subs           |   1,068 |     0.94 |     1.38 |
| protocol reEvaluateQueries               | 10k held subs      |      79 |    12.61 |    24.15 |
| protocol mutation handling               | 10k active queries |      87 |    11.51 |    17.18 |

### Tier 3 — Storage substrate (better-sqlite3, file-backed)

| Workload                                           | Size       | ops/sec | p50 (ms) | p99 (ms) |
| -------------------------------------------------- | ---------- | ------: | -------: | -------: |
| sqlite bulk insert ×5000 (indexed, batched commit) | 5k rows/op |       4 |   256.41 |   890.62 |
| blob putBlob                                       | 64 KB      |   6,470 |    0.155 |     5.00 |
| blob putBlob                                       | 1 MB       |     356 |     2.81 |    46.93 |
| blob getBlob                                       | 64 KB      |  41,222 |    0.024 |    0.094 |
| blob getBlob                                       | 1 MB       |   3,961 |    0.252 |    0.987 |
| blob put+delete churn                              | 64 KB      |   9,581 |    0.104 |     1.13 |

Bulk insert is ~4 batches/sec × 5,000 rows ≈ 20k indexed row-writes/sec (high
variance, dominated by fsync).

### Platform primitives

| Workload                                      | Volume      |   ops/sec | p50 (ms) | p99 (ms) |
| --------------------------------------------- | ----------- | --------: | -------: | -------: |
| udf executor query invocation                 | mock module |   513,362 |    0.002 |    0.003 |
| udf executor mutation invocation              | mock module |   349,379 |    0.002 |    0.009 |
| udf executor action invocation                | mock module |   497,414 |    0.002 |    0.003 |
| system executeLocal query idMapGet            | 1k id-map   |    25,362 |    0.039 |    0.080 |
| system executeLocal mutation idMapSet update  | 1k id-map   |    12,364 |    0.081 |    0.133 |
| system executeLocal query pendingGetAll       | 1k pending  |     8,554 |    0.117 |    0.201 |
| scheduler schedule + cancel                   | —           | 3,791,744 |   <0.001 |   <0.001 |
| subscription invalidate by table              | 5k subs     |     7,523 |    0.133 |    0.162 |
| subscription invalidate dependency-aware      | 5k subs     |     2,218 |    0.451 |    0.604 |
| runtime executeLocal query authStateGetActive | —           | 1,701,643 |    0.001 |    0.001 |

UDF executor rows use mock modules — they measure executor dispatch overhead,
not handler work (the real-handler cost is in the Tier-2 `compute` suite).

### Remote engine

| Workload                                 | Volume      | ops/sec | p50 (ms) | p99 (ms) |
| ---------------------------------------- | ----------- | ------: | -------: | -------: |
| resolve cycle across 5 tables            | mock remote |     124 |     7.87 |    16.01 |
| stale remote snapshot after local delete | 1k docs     |      75 |    13.26 |    18.73 |

## Profiling (where the time goes)

`vp run --filter benchmarks profile` installs the runtime's in-memory
OpenTelemetry exporter (`installInMemoryTracing`), runs a mutation + query
workload through the real hot path, and prints a per-span breakdown. The runtime
emits spans on `executeLocal.mutation` / `executeLocal.query`, `db.commit`,
`db.applyIndexChanges`, and `db.paginate`, so you can see the cost split without
ad-hoc timers:

```
span                                     count   mean    p50    p99
executeLocal.mutation                      300  0.145  0.119  1.988
  db.commit                                300  0.051  0.047  0.101
    db.applyIndexChanges                   300  0.045  0.041  0.091
executeLocal.query (take 20)               300  1.686  1.676  2.052
db.paginate (pageSize 50)                  200  0.018  0.017  0.034
```

This breakdown is what drove the optimizations below — it showed the mutation
cost was almost entirely index maintenance, then (after the fix) that index
maintenance is now a third of an already-tiny mutation. Spans are noop when no
tracer is installed, so the regular `bench` numbers are unaffected.

### Cold-open resolve (scoped, 499 docs)

`benchmarks/coldopen.test.ts` profiles opening a cold project scope (no local
docs) against a mock remote that returns ~499 docs in paginated full-mode
resolves. It counts how many times `resolveTable` runs for one open and breaks
down the resolve hot path (`prepareInput` Yjs state-vector encode, remote
`fetch`, `merge`, `ingest`, `prune`).

```
                                              resolveTable  query   prepareInput(warm)  ingest passes
before  (redundant warm re-resolve)                      2     10   1× @ 499 docs (~21ms)  499 + 499
after   (de-dup + streamed ingest)                       1      5   none (only cold 0-doc) 100·4 + 99 + prune
```

The cold open used to resolve the scope **twice**: the cold pass (0 local docs,
fast), then a redundant **warm** pass over all 499 docs (`initYjsDoc` +
`Y.encodeStateVector` per doc, **0 diffs applied** — pure waste) triggered when
the live `onUpdate` subscription's first paginated snapshot fired
`onPartialResponse → resolveTable` at a `collectionSeq` we had **just** resolved
at. The fix records the last resolved `collectionSeq` per scope and skips a
partial-mode re-resolve at or below it, and streams the resolve ingest per page
(first page paints before the full resolve completes; `collectionSeq`/metadata
advance once, after all pages, with a final prune for absent docs). Result:
`resolveTable` runs **once**, the warm 499-doc encode pass is gone, and remote
round-trips halve.

## Optimizations & fixes from stress testing

Running these at offline-ceiling volumes, with the OTel breakdown above,
surfaced and fixed the following:

- **Local write path: ~38 ms → ~0.12 ms p50 at 10k (~300×).** Two rounds: (1)
  every commit used to full-sort the whole table's in-memory indexes (O(n log
  n)); the SQL commit path now maintains them incrementally. (2) the incremental
  path still ran an O(n) `Set`-build duplicate scan **per index, per commit** —
  the OTel breakdown showed that was ~95% of the mutation. Since index keys end
  in `_id` (unique), a duplicate insert always lands adjacent to its existing
  entry, so the check is now O(1) at insert time. Index maintenance dropped 2.37
  ms → 0.045 ms at 10k. (An O(log n) tree was considered but the splice is now
  negligible, so it isn't worth the rewrite.)
- **O(n²) pagination → O(pageSize) per page (~14× on a full walk, ~120× on a
  first page).** `paginate` re-evaluated the entire query on every page and
  linearly scanned to the cursor `_id`, so walking a range was O(n²). It's now a
  bounded index seek: the cursor encodes the order-key of the last row, resuming
  appends a `> cursor` bound and reads only `pageSize` rows (pushed down to both
  the SQLite scan and the in-memory index window, with an `_id` tiebreak for
  ties on the order field). The redundant sync `Database.paginate` (no callers)
  was removed; `paginateAsync` is the single path.
- **Unbounded `take/first/unique` + `.filter()` on the engine source path.**
  When a `limit` (take/first/unique) and a `.filter()` were both present, the
  engine read the entire range/table into JS, filtered, then sliced — so
  `first()` over a filtered scan paid for the whole table. The engine now reads
  the (already ordered) source in a doubling window and stops once enough rows
  survive the filter, matching native's streamed bounded read. ~1.7× on a
  selective arithmetic filter at 10k; cost now tracks the match position, not
  table size. (Filters SQLite can push down were already bounded via the SQL
  `LIMIT`; this closes the JS-fallback gap.) `first` is `take(1)` and `unique`
  is `take(2)`, so both inherit the bound; `unique`'s "more than one" check is
  unchanged.
- **Redundant JS re-sort of already-ordered sources.** `_evaluateQuery(Async)`
  always called `_sortResults`, even when the source reader had already emitted
  rows in the requested order (SQLite `ORDER BY`, the in-memory sorted index
  window). Source evaluations now carry a `presorted` flag and the engine skips
  the O(n log n) pass when set — guarded to stay correct: the `getDocuments`
  fallback (always ascending) is only marked presorted for ascending queries.
  Marginal on filtered scans (filter eval dominates), but removes a wasted pass.
- **Cold-open resolve ran twice (redundant warm 499-doc re-resolve).** Opening a
  cold scope resolved it once cold (0 local docs, fast), then immediately
  re-resolved the full set warm — `initYjsDoc` + `Y.encodeStateVector` per doc
  with 0 diffs applied — because the live `onUpdate` subscription's first
  paginated snapshot fired `onPartialResponse → resolveTable` at the
  `collectionSeq` we had just resolved at. The engine now tracks the last
  resolved `collectionSeq` per scope and skips partial-mode re-resolves at/below
  it; resolve ingest also streams per page (first page observable before the
  full resolve completes; metadata/`collectionSeq` advance once, after
  completion, with a final prune of absent docs). `resolveTable` invocations 2 →
  1, remote round-trips 10 → 5, the ~21 ms warm encode pass eliminated. See the
  cold-open profiler above. Streaming uses a new
  `ingestDocuments({ deleteAbsent, keepIds })` option so earlier pages aren't
  deleted by later ones.
- **O(n²) in offline reference hydration** — `engine.ts` `hydrateDocumentsById`
  filtered the whole table with `ids.includes()` per doc; now a `Set` (O(n)).
- **Per-query index-definition allocation** — `_getIndexDefinitions` rebuilt its
  array on every call (several per query); now memoized per table (the schema is
  immutable after construction).
- **Full-table reads overflowed past ~128k rows** — `getAllDocuments` /
  `getDocumentsByTables` / store refresh spread an entire table into
  `Array.prototype.push(...rows)`, throwing `RangeError` once a table exceeded
  the engine's spread-arg limit (lower on JSC/Hermes). Now they append in a
  loop.
- **Document ids collided under rapid same-millisecond mutations** — the UDF
  deterministic PRNG was seeded from `Date.now()`; the default seed now mixes in
  a per-invocation counter. (Latent before the write-path speedup made same-ms
  mutations common.)
- **Tracing wrappers allocated a span on every call, even with no tracer (single
  largest closure-refactor follow-up win).** Every Database / QueryEngine /
  scheduler / blob / UDF operation was wrapped in `withSpan` / `withSpanSync`,
  which called `getTracer()`, allocated a `Span`, and ran `setStatus`/`end` on
  every invocation — including the default case where no tracer provider is
  installed. A module-level `tracingActive` flag (flipped on by
  `installInMemoryTracing` / `installNodeTracing` / `installBrowserTracing`, off
  in their close handlers) now short-circuits both wrappers to invoke the
  function against a shared no-op `Span` with zero allocation when tracing is
  off. A controlled before/after on the same machine showed scheduler
  schedule+cancel +71%, UDF mutation invocation +49%, indexed point lookup +63%,
  blob 1 MB get +36%, with ~40 of 53 benches >5% faster.
- **`get x() { return x; }` accessors over closure constants regressed hot-path
  reads 30–56%.** Converting the internal classes to closure factories initially
  wrapped every readonly subsystem reference (`db`, `executor`, `scheduler`, …)
  in a getter. V8 cannot inline-cache a getter that returns a closure-captured
  variable, so each field read became a function call. Replacing the getters
  with direct property shorthand in the returned object literal
  (`{ db, executor, … }`) restored monomorphic property reads and recovered the
  regression; getters are now used only for genuinely mutable state (e.g. the
  live MVCC `timestamp`).
- **Per-call allocation cleanup on the remaining hot paths.** A pass to remove
  per-invocation allocations: a prepared-statement cache at the better-sqlite3
  driver wrapper (`Map<sql, Statement>`); `getIndexedDocuments` skips its dedup
  `Set`s when there can be no duplicates and collapses a `.map().filter().map()`
  chain to one loop; `resolveOrderKey` allocates its `pinned` `Set` lazily (only
  when an `Eq` range bound exists) and `resolveIndexFields` returns memoized
  field arrays instead of spreading per call; the two `.filter()` closures
  inside `paginateSeekAsync`'s retry loop are hoisted to explicit loops; UDF
  `patchGlobals` caches the three `Object.getOwnPropertyDescriptor` lookups at
  module init instead of per invocation; `toArrayBuffer` uses
  `ArrayBuffer.prototype.slice` instead of allocate-and-copy; the SQLite client
  sets `PRAGMA synchronous = NORMAL` alongside WAL; and `decodeCursor` keeps a
  one-slot cache so sequential `paginate` calls skip re-parsing the cursor.
- **Remote-snapshot merge built three throwaway arrays per ingest.**
  `mergeRemote` constructed its working map via `localDocs.filter().map()`,
  folded the remote diff with an object-literal `reduce` accumulator, then
  materialized the result with `Array.from(map.values())` — three intermediate
  allocations for every snapshot, dominating the 1,000-doc remote-ingest path.
  Rewritten as explicit `for` loops over the inputs filling pre-declared output
  arrays, which returned the stale-remote-snapshot and resolve-cycle benches to
  parity after they had regressed in the closure refactor.

The class→factory migration itself was perf-neutral once the wrapper allocation
and accessor overhead above were addressed — the regressions came from those,
not from method dispatch on plain objects vs prototypes.

## What these numbers do and don't show

- **Tier 1 CRDT** and **Tier 2 compute/queries/storage** are the representative,
  real-path numbers.
- **Component** and **platform UDF executor** rows use a mock store / mock
  modules to isolate logic; treat them as logic throughput, not storage figures.
- There is **no CI regression gate** yet. These are a recorded baseline; gating
  becomes relevant at release and when swapping SQLite → Turso. Re-run on the
  same machine to compare. (The aggregate `bench` run occasionally exits
  non-zero from a vitest teardown race across the 8 modules; per-suite runs are
  clean and the results/JSON are unaffected.)
