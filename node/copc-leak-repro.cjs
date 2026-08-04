// copc@0.0.8 — Las.PointData.decompressFile leaks its two WASM allocations.
//
// The leak is measured against the REAL upstream function, by wrapping the
// lazPerf instance's own _malloc/_free. Nothing is reimplemented for that
// measurement, so there is no hand-transcribed copy to distrust: arm A calls
// `Las.PointData.decompressFile` exactly as every consumer does.
//
// A freeing mirror appears only in arm B, to demonstrate that adding the two
// _free calls both stops the leak AND still decodes correctly — the outputs of
// the two arms are asserted byte-identical.
//
// Run: node copc-leak-repro.cjs <path-to.laz> [iterations]

const fs = require('node:fs')
const assert = require('node:assert')
// COPC_MODULE points arm A at a different copc build (e.g. a bundled PR
// branch) without touching the measurement. Default: the npm install.
const { Las } = require(process.env.COPC_MODULE || 'copc')
const { createLazPerf } = require('laz-perf')

const FILE = process.argv[2]
// Default sized so the signal is unambiguous. A small N (the old default of 40)
// leaves the leak comparable to laz-perf's 64 KB page granularity, and the run
// can print "no clear leak" for a library that is definitely leaking.
const N = Number(process.argv[3] || 2000)

if (!FILE) {
  console.error('usage: node copc-leak-repro.cjs <path-to.laz> [iterations]')
  process.exit(2)
}

/** Wraps _malloc/_free to count outstanding bytes. This is the primary metric:
 *  HEAPU8.byteLength is committed CAPACITY, which an allocator may grow for
 *  reasons other than a leak, and which can stay flat while allocations leak
 *  inside already-committed pages. Outstanding allocations have no such
 *  ambiguity — if every malloc is matched by a free, it returns to baseline. */
function instrument(lazPerf) {
  const live = new Map()
  const stats = { outstanding: 0, mallocs: 0, frees: 0 }
  const rawMalloc = lazPerf._malloc.bind(lazPerf)
  const rawFree = lazPerf._free.bind(lazPerf)
  lazPerf._malloc = (n) => {
    const p = rawMalloc(n)
    if (p) {
      live.set(p, n)
      stats.outstanding += n
      stats.mallocs++
    }
    return p
  }
  lazPerf._free = (p) => {
    if (live.has(p)) {
      stats.outstanding -= live.get(p)
      live.delete(p)
      stats.frees++
    }
    return rawFree(p)
  }
  return stats
}

/** Upstream decompressFile with the two missing _free calls added.
 *  NOTE THE ORDER: reader.delete() FIRST, then free. copc's decompressChunk
 *  does the opposite (_free, _free, decoder.delete) — it releases memory the
 *  decoder was opened on before destroying the decoder. Do not copy that
 *  ordering into the fix. */
async function decompressFileFreeing(file, lazPerf) {
  const header = Las.Header.parse(file)
  const { pointCount, pointDataRecordLength } = header
  const out = new Uint8Array(pointCount * pointDataRecordLength)
  const blobPointer = lazPerf._malloc(file.byteLength)
  const dataPointer = lazPerf._malloc(pointDataRecordLength)
  // A zero pointer is OOM; HEAPU8.set at offset 0 would silently corrupt the
  // heap rather than fail.
  if (!blobPointer || !dataPointer) throw new Error('lazPerf._malloc returned 0 (out of memory)')
  // `reader` is constructed INSIDE the try, and the try opens immediately after
  // the allocations: if `new lazPerf.LASZip()` throws, the finally still runs
  // and both pointers are freed. Upstream's shape (construct before try) would
  // leak both on that path even after the frees are added.
  let reader = null
  try {
    reader = new lazPerf.LASZip()
    lazPerf.HEAPU8.set(new Uint8Array(file.buffer, file.byteOffset, file.byteLength), blobPointer)
    reader.open(blobPointer, file.byteLength)
    for (let i = 0; i < pointCount; ++i) {
      reader.getPoint(dataPointer)
      out.set(
        new Uint8Array(lazPerf.HEAPU8.buffer, dataPointer, pointDataRecordLength),
        i * pointDataRecordLength,
      )
    }
  } finally {
    if (reader) reader.delete()
    lazPerf._free(blobPointer)
    lazPerf._free(dataPointer)
  }
  return out
}

async function arm(label, fn) {
  const raw = fs.readFileSync(FILE)
  const file = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  // One instance per arm, as every consumer has one long-lived instance.
  const lazPerf = await createLazPerf()
  const stats = instrument(lazPerf)

  // Warmup is common-mode (both arms get the same one) and every number below
  // is a between-arm comparison, so it cannot manufacture a difference — it can
  // only under-report the leaking arm.
  for (let i = 0; i < 50; i++) await fn(file, lazPerf)

  const base = { ...stats }
  let out = null
  let fed = 0
  for (let i = 0; i < N; i++) {
    out = await fn(file, lazPerf)
    fed += file.byteLength
  }

  const leaked = stats.outstanding - base.outstanding
  const mallocs = stats.mallocs - base.mallocs
  const frees = stats.frees - base.frees
  console.log(
    `${label.padEnd(26)} leaked ${String(leaked).padStart(9)} B   ` +
      `mallocs ${String(mallocs).padStart(5)}  frees ${String(frees).padStart(5)}   ` +
      `fed ${String(fed).padStart(9)} B   ratio ${(leaked / fed).toFixed(4)}`,
  )
  return { leaked, mallocs, frees, fed, out }
}

;(async () => {
  console.log(`fixture ${FILE} (${fs.statSync(FILE).size} B)   iterations ${N}\n`)
  const up = await arm('upstream decompressFile', (f, l) => Las.PointData.decompressFile(f, l))
  const fx = await arm('with the two _free calls', decompressFileFreeing)

  // Does the fix still decode correctly? An upstream patch that stops the leak
  // by breaking the output would be worthless, and nothing else here checks it.
  assert.deepStrictEqual(
    Buffer.from(up.out),
    Buffer.from(fx.out),
    'the freeing variant produced DIFFERENT point data than upstream',
  )
  console.log('\noutput check: both arms decoded byte-identical point data')

  const perCall = up.leaked / N
  console.log(
    `per call: ${perCall} B leaked vs ${up.fed / N} B input ` +
      `(difference ${perCall - up.fed / N} B = pointDataRecordLength, the second _malloc)`,
  )

  // Both conditions required. `up > fx * 4` alone degenerates to `up > 0` when
  // fx is 0, so a single stray page would "reproduce" the leak.
  const ok = up.frees === 0 && fx.frees === fx.mallocs && fx.leaked === 0 && up.leaked / up.fed > 0.5
  console.log(`\nVERDICT: ${ok ? 'leak reproduced' : 'no clear leak'}`)
  process.exit(ok ? 0 : 1)
})()
