# `copc.js` — `Las.PointData.decompressFile` never frees its two WASM allocations

`decompressFile` calls `_malloc` twice and its `finally` block only calls
`reader.delete()`. Its sibling `decompressChunk`, thirty lines above, frees
both. Every call therefore leaks `file.byteLength + pointDataRecordLength`
bytes into the lazPerf instance permanently.

Source, `src/las/point-data.ts` on `master` at
[`dd66745`](https://github.com/connormanning/copc.js/blob/dd667453809a76e5b885859782d1cbdeaf0501ec/src/las/point-data.ts)
(that commit is titled _"Autoformat everything - no functional changes"_; the
last functional change to the file predates it). Identical in the published
`copc@0.0.8`, `lib/las/point-data.js`.

```ts
// decompressChunk — frees both (L59-62)
} finally {
  LazPerf._free(blobPointer)
  LazPerf._free(dataPointer)
  decoder.delete()
}

// decompressFile — frees neither (L100-101)
} finally {
  reader.delete()
}
```

---

## Measurement

Both harnesses count **outstanding WASM allocations** — bytes `_malloc`'d minus
bytes `_free`'d — by wrapping the allocator itself.

This is deliberately _not_ `HEAPU8.byteLength`. Committed linear-memory capacity
can grow for reasons unrelated to a leak (emscripten's `emscripten_resize_heap`
overgrows by ~20%), and can stay flat while allocations leak inside pages
already committed. Outstanding-allocation counting has neither ambiguity: if
every `malloc` is matched by a `free`, it returns to baseline.

Two scope notes on that metric, both of which cut against overstating the bug:

- **It counts JS-initiated allocations only.** The wrapper sits on the wasm
  module's exported `malloc`/`free`, so it sees every `lazPerf._malloc` call
  made from JS — which is exactly where this defect lives — but C++ inside the
  module calling `malloc`/`operator new` directly never crosses the JS boundary
  and is invisible to it. The control arm's completely flat committed heap is
  the corroborating check that internal allocations are not leaking either.
- **It counts bytes requested, not allocator footprint.** dlmalloc headers and
  alignment mean real consumption is somewhat higher, so these figures are a
  lower bound.

Committed heap capacity is reported as a secondary number in the **browser**
harness; the Node harness reports allocation accounting only.

### 1. One-variable control (Node), on a real production tile

Fixture: `ept-data/4-8-6-7.laz` from the public USGS 3DEP EPT collection
`NC_Phase5_Yancey_2017` — **289,466 bytes**, 39,207 points. This is the exact
input shape Potree's `EptLaszipLoader` hands to `decompressFile`: one whole
per-node `.laz` file.

```
fixture ept-node-real.laz (289466 B)   iterations 200

upstream decompressFile    leaked  57899000 B   mallocs 400  frees   0   ratio 1.0001
with the two _free calls   leaked         0 B   mallocs 400  frees 400   ratio 0.0000

output check: both arms decoded byte-identical point data
per call: 289495 B leaked vs 289466 B input (difference 29 B = pointDataRecordLength)
```

**200 tiles leak 57.9 MB.** Per-call leak is the input buffer plus one point
record, to within 29 bytes. At this node size, 2 GiB of WASM heap is ~7,400
tiles; the ~1.5 GB process budget that killed the mobile session is ~5,400.

Arm A is the real upstream `Las.PointData.decompressFile` — not a transcription.
Arm B is a local implementation of the same routine plus the two `_free` calls;
being a transcription, it is the one part of this a reader should eyeball against
`point-data.ts` rather than take on trust. One fresh lazPerf instance per arm.

The same comparison on the small COPC fixture (`npm run repro:node:small`), kept
because the browser harness below uses it too:

```
fixture node.laz (5894 B)   iterations 2000

upstream decompressFile    leaked  11860000 B   mallocs  4000  frees     0   fed  11788000 B   ratio 1.0061
with the two _free calls   leaked         0 B   mallocs  4000  frees  4000   fed  11788000 B   ratio 0.0000

output check: both arms decoded byte-identical point data
per call: 5930 B leaked vs 5894 B input (difference 36 B = pointDataRecordLength, the second _malloc)

VERDICT: leak reproduced
```

`5930 = 5894 + 36` — the file buffer plus one point record, exactly the two
`_malloc` calls. Nothing about that is an allocator artifact: **4000 mallocs, 0
frees.** The byte-identical output check exists because a patch that stops the
leak by breaking decoding would be worthless.

```bash
npm install && npm run repro:node
```

### 2. Real-consumer impact (Potree, in Chrome)

`potree@1.8.0`, its own bundled `libs/copc/index.js` and its own
`src/workers/EptLaszipDecoderWorker.js`, **both unmodified**, driven exactly as
`src/loader/ept/LaszipLoader.js` drives them.

```
iterations 500   warmup 50

PRIMARY — outstanding wasm allocations:
  decompressFile  (EPT path)   leaked 2965000 B   mallocs 1000  frees    0   fed 2947000 B   decoded 500/500
  decompressChunk (COPC path)  leaked       0 B   mallocs 1000  frees 1000   fed 2544500 B   decoded 500/500

SECONDARY — committed heap capacity:
  decompressFile  (EPT path)   6.56 -> 9.50 MB   grew 3080192 B
  decompressChunk (COPC path)  5.25 -> 5.25 MB   grew       0 B

leaking arm: 5930.0 B leaked per call vs 5894.0 B decoded per call (ratio 1.0061)
```

Same 5930 B/call as the Node arm.

These are Potree's two real branches: `EptLaszipLoader` fetches a whole
`ept-data/<key>.laz` per node and sets `isFullFile: true` → `decompressFile`;
`CopcLaszipLoader` fetches a node slice and sets `isFullFile: false` →
`decompressChunk`. So **in Potree specifically, the EPT-LAZ loader hits this
defect and the COPC loader does not.**

That split is a fact about Potree's two loaders, not about the file formats:
loaders.gl and Giro3D both call `decompressFile` on COPC data, so "COPC is safe"
does not generalize past Potree.

Note the arms decode different inputs (5894 B vs 5089 B per call) because those
are genuinely different call sites; each arm's `fed` is its own input. That is
why the one-variable Node control above, not this table, is the primary
evidence. This table shows a real consumer reaching the defect.

```bash
git clone --branch 1.8 --depth 1 https://github.com/potree/potree.git
cp -r potree-browser potree/leakrepro && cp node.laz potree/leakrepro/
cp potree/libs/copc/laz-perf.wasm potree/leakrepro/   # emscripten resolves the
                                                      # wasm relative to the worker URL
cd potree && python3 -m http.server 8793 &
# then open http://127.0.0.1:8793/leakrepro/index.html?n=500
```

---

## Observed impact — a real app, a real device, a kernel-recorded kill

The harnesses above measure the leak. This is what it did in production.

A production web app that streams USGS 3DEP EPT tiles into a WebGL scene decodes
every node through `Las.PointData.decompressFile`. Its first-person view had been
dying on iPhone for weeks: the tab silently reloads mid-session — no JS error, no
`onerror`, and the page's own memory ledger reading **108 MB** at the moment of
death.

Same build, same device (iPhone, iOS 26.5.2), same scripted walk. The **only**
variable is whether `decompressFile` frees its two allocations:

| arm                        | outcome                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| upstream (leaks)           | **died at T+267s** — `killing_highwater_process [WebKit.WebContent] 1574226KB` (1537 MB) |
| with the two `_free` calls | survived 311s, kernel clean                                                              |
| with the frees, long run   | survived **988s**, zero highwater kills of any process                                   |

The control's death at 267s matches two earlier baselines of the same crash, at
240s and 263s. The kill line comes from the device's own syslog, not inferred
from the page.

Why it stayed invisible for a month: the leaked bytes live in WASM linear memory,
so they are neither a GL allocation nor an app-tracked buffer. Both instruments
that team had been staring at were blind to it **by construction** — hence a
ledger reading 108 MB against a 1537 MB kill.

This is one consumer's workload, not a general severity claim: a mobile browser
tab with a ~1.5 GB budget dies far sooner than a desktop one. What it does
establish is that this leak alone is sufficient to kill a real session, and that
adding the two `_free` calls is sufficient to stop it.

---

## Suggested fix — mind the ordering

```diff
   const blobPointer = LazPerf._malloc(file.byteLength)
   const dataPointer = LazPerf._malloc(pointDataRecordLength)
-  const reader = new LazPerf.LASZip()
+  let reader = null
   try {
+    reader = new LazPerf.LASZip()
     …
   } finally {
-    reader.delete()
+    if (reader) reader.delete()
+    LazPerf._free(blobPointer)
+    LazPerf._free(dataPointer)
   }
```

Two details worth not getting wrong:

**Construct the reader inside the `try`.** Both `_malloc`s happen before it, so
if `new LazPerf.LASZip()` throws, a naive "just add the frees" patch still leaks
both pointers — the `finally` is not yet in scope. `decompressChunk` has the
same shape and the same exposure.

**Delete before freeing.** `decompressChunk` does the reverse: it `_free`s
`blobPointer` and only then calls `decoder.delete()`, while the decoder was
`open()`ed on that pointer. Whether that actually dereferences the buffer
depends on laz-perf's destructor, which we did not read and neither harness
exercises — so treat this as _unsafe ordering by construction, not a confirmed
use-after-free_. The fix above avoids the question by deleting first.

---

## Other consumers on this call path

Call expressions read from source. **Only Potree was measured.**

| project           | call site                                                                                                                           | how lazPerf is held                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| potree/potree     | `src/workers/EptLaszipDecoderWorker.js:20` — `Copc.Las.PointData.decompressFile(u)`                                                 | copc's module-scope singleton              |
| iTowns/itowns     | `packages/Main/src/Loader/LASLoader.js:179` — `Las.PointData.decompressFile(bytes, this._initDecoder())`                            | its own instance, cached in `_wasmPromise` |
| visgl/loaders.gl  | `modules/las/src/lib/copc/parse-las.ts` — `Las.PointData.decompressFile(new Uint8Array(arrayBuffer))`                               | copc's module-scope singleton              |
| giro3d-org/giro3d | `src/sources/las/worker.ts`, `src/sources/LASSource.ts`, `src/sources/PotreeSource.ts` — `Las.PointData.decompressFile(…, lazPerf)` | shared `getLazPerf()`                      |

Supplying your own lazPerf does **not** avoid the leak — it only decides whose
heap grows. Every one of these instances is cached and long-lived.

---

## Limitations

Stated plainly, because several of these are the first things worth attacking.

- **Only Potree was measured.** The other three rows are source reads.
- **Measured at production tile size.** The primary Node result uses a real
  289 KB USGS 3DEP EPT node, so the per-call figure is no longer extrapolated
  from a toy fixture. The browser/Potree harness still uses the small COPC file,
  because its control arm needs a COPC hierarchy to fetch a genuine chunk from.
- **In practice the binding limit is process RSS, not the 2 GiB WASM cap.** The
  production kill above happened at ~1.5 GB of total process memory, well below
  any WASM ceiling, because the OS reclaims the tab first. On a memory-constrained
  device that is the number that matters.
- **No end-to-end crash was demonstrated _in Potree_.** One was demonstrated in
  another consumer — see "Observed impact" above. We did not run a Potree session
  to failure; only the mechanism and the accumulation are shown there. An earlier
  draft of this README quoted a `Cannot enlarge memory … Aborted()` trace as if it
  were that demonstration; it was not — that trace came from a broken control
  arm, see "Probe hygiene".
- **Accumulation across a session is confirmed, not assumed.** Potree pools its
  decoder workers (`WorkerPool.getWorker` / `returnWorker`) and there is no
  `.terminate()` call anywhere in `src/`, so a pooled worker — and the lazPerf
  heap inside it — lives as long as the page. The leak accumulates across the
  whole session rather than resetting per node.
- **The scope claim is about this defect only.** "COPC does not leak" means
  `decompressChunk` frees what it allocates on the path tested, not that COPC
  ingestion is leak-free generally.
- Environment: Node v26.3.0, Chrome stable via Playwright `channel: 'chrome'`,
  `copc@0.0.8`, `laz-perf@0.0.6` (pinned in `package.json`), `potree@1.8.0`.

## Probe hygiene

Findings from an earlier draft of this repro, kept because they are the failure
modes a reader should check for:

- The first control arm fed `decompressChunk` a **whole file** with the file's
  point count. It tried to decode the entire file as one chunk, requested
  2.7 GB, and aborted the worker. That looked like a dramatic result and was a
  broken probe. The control now fetches a genuine COPC node via `Copc.create` +
  `loadHierarchyPage`.
- `fed` counted the whole fixture for **both** arms even though the control
  decodes a smaller slice, making its denominator wrong. Each arm now counts the
  bytes it actually decoded.
- The original metric was heap `byteLength`, which invites the "that's just
  allocator high-water mark" rebuttal. Replaced with malloc/free accounting,
  which cannot be explained that way.
- Decode counts are **enforced** (`decoded 500/500`; the worker throws on a
  mismatch), so a silently-skipped decode cannot masquerade as a clean arm.
- The 50-call warmup is common-mode across arms and every figure is a between-arm
  comparison, so it cannot manufacture a difference — it can only _under_-report
  the leaking arm, since the warmup's own leaked bytes sit outside the measured
  window.
