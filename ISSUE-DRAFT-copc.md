`decompressFile` allocates two buffers and frees neither. `decompressChunk`, in
the same file, frees both.

```ts
// decompressChunk — src/las/point-data.ts L59-62
} finally {
  LazPerf._free(blobPointer)
  LazPerf._free(dataPointer)
  decoder.delete()
}

// decompressFile — L100-101
} finally {
  reader.delete()
}
```

Every call leaks `file.byteLength + pointDataRecordLength` bytes into the lazPerf
instance. Since `getLazPerf()` caches one instance at module scope — and callers
that supply their own cache theirs too — nothing ever reclaims it for the life of
the page or process.

Still present on `master` at
[`dd66745`](https://github.com/connormanning/copc.js/blob/dd667453809a76e5b885859782d1cbdeaf0501ec/src/las/point-data.ts)
and in published `copc@0.0.8`.

## Reproduction

Repro repo: **https://github.com/dsmithn/copc-decompressfile-leak** — two harnesses, both ~30 seconds.

**Node**, counting the allocator directly (`malloc` bytes minus `free` bytes)
rather than heap size, so allocator growth policy can't explain the result. Two
arms:

- **Arm A — upstream.** Calls the real exported `Las.PointData.decompressFile`.
  This is the arm the leak measurement rests on.
- **Arm B — control.** A local reimplementation of the same routine with the two
  `_free` calls added, to show the frees are what closes the gap.

Fixture is a real tile — `ept-data/4-8-6-7.laz` from the public USGS 3DEP
collection `NC_Phase5_Yancey_2017`, 289,466 B / 39,207 points — i.e. exactly what
an EPT viewer hands this function:

```
fixture ept-node-real.laz (289466 B)   iterations 200

upstream decompressFile    mallocs 400  frees   0   leaked 57,899,000 B   ratio 1.0001
with the two _free calls   mallocs 400  frees 400   leaked          0 B   ratio 0.0000

per call: 289495 B leaked vs 289466 B input
          (difference 29 B = pointDataRecordLength, the second _malloc)
```

**200 decodes of this tile leak 57.9 MB.** The per-call figure is exactly the two
allocations: 289,466 + 29 = 289,495 bytes, the input buffer plus one point
record, with nothing unaccounted for. An allocator growth policy does not
produce 400 mallocs and 0 frees. Both arms decode byte-identical point data
(asserted), so adding the frees changes nothing but the leak.

**Browser**, driving Potree 1.8's own bundled copc build and its own decoder
worker, unmodified: its EPT loader (`decompressFile`) leaks 5930 B/call while its
COPC loader (`decompressChunk`) holds at exactly 0. Those two arms are different
real call sites with different inputs (5894 vs 5089 B/call), so treat this as
call-path confirmation; the Node run above is the controlled comparison. The
5930 − 5894 = 36 B difference is that fixture's own `pointDataRecordLength`.

## Impact

Scales with how long one lazPerf instance lives: **leaked bytes ≈ (node size) ×
(nodes decoded) per instance.** Instances are typically long-lived — Potree's
decoder workers are pooled and there is no `.terminate()` call in its `src/`, so
one instance serves a whole session. A Node process decoding many files in a loop
behaves the same way.

At 289 KB/tile that is ~7,400 decodes to a 2 GiB WASM ceiling (Emscripten's
default growth limit for such builds), and ~5,570 to the 1,574,226 KiB the
kernel recorded at the mobile kill below — a zero-baseline figure, since that
number is total process RSS which this leak contributes to rather than fills.
Both figures are arithmetic from the measured per-call leak, not observed
crashes — **no Potree session was run to a memory ceiling.**

What we did observe, in **a different consumer of this same call path — not
Potree**: a production viewer streaming USGS 3DEP EPT tiles died reproducibly on
iPhone at ~267 s with kernel log
`killing_highwater_process [WebKit.WebContent] 1574226KB`; the same build with
the two frees added survived 988 s with no kills. That is one app's workload on a
memory-constrained device, not a general severity claim — and the ~1.5 GB is
total process RSS, which this leak contributes to rather than solely accounts
for. It is included because the patched build ran 988 s where three unpatched runs
died at 240, 263 and 267 s. That is strong evidence the leak is sufficient to
end a real session, not proof that it is the sole cause.

Worth noting for anyone else hunting this: the page's own memory accounting read
108 MB at the moment of that kill. WASM linear memory is neither a JS-heap
allocation nor a GPU one, so typical in-page instrumentation cannot see it.

## Suggested patch

```diff
-  const blobPointer = LazPerf._malloc(file.byteLength)
-  const dataPointer = LazPerf._malloc(pointDataRecordLength)
-  const reader = new LazPerf.LASZip()
+  let blobPointer = 0
+  let dataPointer = 0
+  let reader: InstanceType<typeof LazPerf.LASZip> | undefined
   try {
+    blobPointer = LazPerf._malloc(file.byteLength)
+    dataPointer = LazPerf._malloc(pointDataRecordLength)
+    reader = new LazPerf.LASZip()
     …
   } finally {
-    reader.delete()
+    reader?.delete()
+    LazPerf._free(blobPointer)   // _free(0) is a no-op
+    LazPerf._free(dataPointer)
   }
```

Everything acquired is acquired _inside_ the `try`, so a throw from the
`LASZip` constructor still releases whatever was obtained first. (Emscripten's
`_malloc` returns 0 or aborts rather than throwing, so the constructor is the
live path here.) Typing and style are obviously yours to adjust — the shape is the point.

We applied the equivalent edit to `copc@0.0.8`'s built `lib/las/point-data.js`
and re-ran against the real exported `Las.PointData.decompressFile`. **Note this
run uses the small fixture at a higher iteration count**, not the 289 KB tile
above — hence 4000 allocations rather than 400:

```
fixture node.laz (5894 B)   iterations 2000

upstream decompressFile (patched)   mallocs 4000  frees 4000   leaked 0 B
output check: byte-identical point data
```

Every allocation returned, decoded output unchanged.

Worth noting the same shape would help `decompressChunk`: it also allocates and
constructs its decoder *before* its `try`, so it leaks both buffers if the
`ChunkDecoder` constructor throws. It just doesn't leak on the path that
succeeds, which is why only `decompressFile` shows up in measurement.

One judgement call in there: the `finally` deletes the reader before freeing the
buffer it was `open()`ed on. `decompressChunk` currently does the reverse. We did
not read laz-perf's destructor and cannot say whether it dereferences the buffer,
so this is a conservative ordering rather than a bug report about
`decompressChunk`.

`dataPointer` is a `pointDataRecordLength` scratch buffer (29 B for the 289 KB
tile above; 36 B for the small fixture)
that each point is copied _out_ of into `outBuffer`, so nothing in the returned
data aliases either allocation — freeing them cannot affect the return value.
Confirmed by the harness asserting byte-identical output.

## Environment

Node harness: `copc@0.0.8`, `laz-perf@0.0.6`, Node v26.3.0, macOS 26.5.2 arm64.
Browser harness: `potree@1.8.0`, Chrome 150.0.7871.187, same machine.
The iPhone runs are from a separate application, on an iPhone 14 Pro
(`iPhone15,2`). I did not record the iOS version at the time of those runs, so
treat the durations as illustrative of scale rather than as a reproducible case.

## What we did not verify

- Only Potree was measured. `iTowns`
  (`packages/Main/src/Loader/LASLoader.js:179`), `loaders.gl`
  (`modules/las/src/lib/copc/parse-las.ts`) and `Giro3D`
  (`src/sources/las/worker.ts`, `LASSource.ts`, `PotreeSource.ts`) call
  `decompressFile` too, but were confirmed by reading source only.
- The browser arm ran on a 5,894 B fixture — only the Node harness exercised a
  real ~289 KB EPT node. Nodes in the wild run ~200 KB–1 MB; above that range the
  proportionality is arithmetic, not measurement.
- We did not run Potree itself to a crash — only the mechanism and the
  accumulation are demonstrated there. The crash above was a different consumer.
- Arm B (the control, with the frees) is a local reimplementation, not the
  exported function — worth eyeballing against `point-data.ts`. The _leak_
  measurement does not depend on it; that rests on Arm A, which calls the real
  `Las.PointData.decompressFile`. The patched-upstream run above also exercises
  the real function.
- The 0-leak result for `decompressChunk` covers the path our harness exercises.
  It is not a claim that COPC ingestion is leak-free in general.

Happy to open a PR if the patch looks right.
