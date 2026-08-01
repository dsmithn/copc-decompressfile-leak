<!-- Filed as https://github.com/potree/potree/issues/1571 — this file is the body as submitted. -->

Loading EPT data leaks WebAssembly memory on every decoded node. The COPC
path, on the successful path exercised here, does not. The cause is in the bundled `libs/copc/index.js`, so it does not go
away when copc.js publishes a fix — the vendored copy has to be updated.

## Where

`src/workers/EptLaszipDecoderWorker.js:20-21` picks between the two functions:

```js
const buffer = isFullFile
    ? await Copc.Las.PointData.decompressFile(u)      // EPT — never frees
    : await Copc.Las.PointData.decompressChunk(...)   // COPC — frees both
```

In the bundled build currently on `develop`, `decompressChunk` frees its two
WASM allocations and `decompressFile` frees neither (deminified from
`libs/copc/index.js`). The measurements further down were taken against the
`potree@1.8.0` bundle; both carry the same two functions:

```js
// decompressChunk
finally { o._free(u), o._free(c), l.delete() }

// decompressFile
c = r._malloc(e.byteLength), l = r._malloc(s), d = new r.LASZip;
try { ... } finally { d.delete() }
```

Each EPT node therefore leaves `file.byteLength + pointDataRecordLength` bytes
allocated in the LazPerf instance.

## Why it accumulates instead of resetting

Decoder workers are pooled and there is no `.terminate()` call in `src/`, so one
LazPerf instance serves a whole session. The leak tracks total bytes decoded for
as long as the page is open.

## Replicating it

Measured against an unmodified `potree@1.8.0` checkout, using its own bundled
copc build and its own decoder worker — nothing patched:

```
EPT loader  (decompressFile)   5930 B leaked per call
COPC loader (decompressChunk)      0 B leaked per call
```

Harness and instructions: https://github.com/dsmithn/copc-decompressfile-leak
(see `potree-browser/`). It wraps `_malloc`/`_free` on the LazPerf instance and
reports requested-minus-returned bytes, so allocator growth policy cannot
account for the result.

## Fix

Reported upstream as https://github.com/connormanning/copc.js/issues/16, with a
suggested patch. Since the build here is vendored, Potree would need the updated
bundle regardless of what upstream releases.

Happy to open a PR against `develop` bumping the bundled copc once upstream
lands a fix — no build artifacts committed, no formatter run.

## What I did not verify

- I did not run Potree to a crash. Only the leak and its accumulation were
  measured here. The out-of-memory failure that led me to this was in a
  different application calling the same function.
- The two arms above decoded different inputs (5,894 vs 5,089 B per call), so
  treat this as confirmation that the leak occurs on a real Potree call path
  rather than as a controlled comparison. The controlled comparison is the Node
  harness in the linked repo.
- The 0-leak result for the COPC path covers only the successful path the
  harness exercises. It is not a claim that COPC ingestion is leak-free in
  general — `decompressChunk` also acquires before its `try`, so it leaks both
  buffers if the `ChunkDecoder` constructor throws.

Filing this mainly so it is on record for anyone else hitting memory growth with
EPT data — no response needed.
