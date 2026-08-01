# DRAFT — issue for potree/potree (not yet filed)

**Title:** EPT loader leaks WASM memory per node — bundled copc.js `decompressFile` never frees its two allocations

---

Potree's EPT loading path leaks WebAssembly memory on every decoded node. The
COPC path does not. The cause is upstream in `copc.js`, but Potree bundles its
own build of it, so an upstream release will not reach Potree without a bump
here.

`Las.PointData.decompressFile` `_malloc`s two buffers and frees neither.
`decompressChunk`, in the same upstream file, frees both — which is why the two
loaders behave differently:

```js
// decompressChunk — frees both
} finally {
  LazPerf._free(blobPointer)
  LazPerf._free(dataPointer)
  decoder.delete()
}

// decompressFile — frees neither
} finally {
  reader.delete()
}
```

Each call leaks `file.byteLength + pointDataRecordLength` bytes into the LazPerf
instance.

## Why it accumulates rather than resetting

Potree pools its decoder workers and there is no `.terminate()` call anywhere in
`src/`, so one LazPerf instance serves an entire session. The leak tracks total
bytes decoded for as long as the page is open, rather than being reclaimed per
node.

## Reproduction

Measured in an unmodified `potree@1.8.0` checkout, using its own bundled copc
build and its own decoder worker — no patches to Potree:

```
EPT loader  (decompressFile)   5930 B leaked per call
COPC loader (decompressChunk)      0 B leaked per call
```

Harness and instructions: https://github.com/dsmithn/copc-decompressfile-leak
(`potree-browser/`). It wraps `_malloc`/`_free` on the LazPerf instance and
reports requested-minus-returned bytes, so allocator growth policy cannot
account for the result.

## Fix

The real fix is upstream — see <UPSTREAM_ISSUE_LINK>. Until a release lands,
bumping or patching the bundled copc build is what would help Potree users.

## What I did not verify

- I did not run Potree to a crash. Only the leak and its accumulation were
  measured. The out-of-memory failure that led me here was in a different
  application that calls the same upstream function.
- The two arms above decoded different inputs (5,894 vs 5,089 B per call), so
  treat this as confirmation that the leak occurs on a real Potree call path,
  not as a controlled comparison. The controlled comparison is in the linked
  repo's Node harness.
- The 0-leak result for the COPC path covers the path this harness exercises. It
  is not a claim that COPC ingestion is leak-free in general.
