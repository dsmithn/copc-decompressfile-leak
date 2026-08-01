// Repro worker. Loads Potree's OWN bundled copc build and Potree's OWN
// EptLaszipDecoderWorker source, unmodified, and drives the latter exactly the
// way src/loader/ept/LaszipLoader.js drives them. Nothing in libs/ or src/ is
// patched.
//
// PRIMARY METRIC: outstanding wasm allocations (bytes malloc'd minus bytes
// freed), obtained by wrapping the wasm module's own `malloc`/`free` exports.
// This is deliberately NOT the heap's byteLength: `memory.buffer.byteLength` is
// committed linear-memory CAPACITY, which an allocator can grow for reasons
// other than a leak (emscripten's emscripten_resize_heap overgrows by ~20%),
// and which can stay flat while allocations leak inside already-committed
// pages. Outstanding-allocation accounting has neither ambiguity: if every
// malloc is matched by a free, it returns to baseline, period.
// Heap capacity is still reported, as a secondary corroborating number.

let wasmMemory = null
let outstanding = 0 // bytes malloc'd and not yet freed
let mallocCalls = 0
let freeCalls = 0
const live = new Map() // pointer -> size

const wrapExports = (ex) => {
  // Copy every export, then swap malloc/free for accounting versions.
  //
  // SCOPE: this counts JS-INITIATED allocations only. Emscripten reads
  // `instance.exports` to build Module._malloc/_free, so every `lazPerf._malloc`
  // call from JS — which is exactly where this defect lives — is counted. C++
  // code inside the wasm module calling malloc/operator new directly never
  // crosses the JS boundary and is invisible here. That is fine for this claim
  // (the two leaked pointers are allocated from JS by copc itself), and the
  // control arm's flat committed heap is the corroborating check that internal
  // allocations are not leaking either.
  const out = {}
  for (const k of Object.keys(ex)) out[k] = ex[k]
  const rawMalloc = ex.malloc
  const rawFree = ex.free
  out.malloc = function (n) {
    const p = rawMalloc.call(this, n)
    if (p) {
      live.set(p, n)
      outstanding += n
      mallocCalls++
    }
    return p
  }
  out.free = function (p) {
    if (live.has(p)) {
      outstanding -= live.get(p)
      live.delete(p)
      freeCalls++
    }
    return rawFree.call(this, p)
  }
  return out
}

const capture = (result) => {
  const instance = result && result.instance ? result.instance : result
  const ex = instance && instance.exports
  if (!ex || !ex.memory || typeof ex.malloc !== 'function') return result
  // laz-perf is identified by exporting BOTH a memory and malloc/free. If a
  // second such module ever loaded, refuse loudly rather than silently measure
  // the wrong one (last-writer-wins would be a wrong number, not an error).
  if (wasmMemory) throw new Error('a second malloc-exporting wasm module loaded — instrument is ambiguous')
  wasmMemory = ex.memory
  const proxied = { exports: wrapExports(ex) }
  return result && result.instance ? { ...result, instance: proxied } : proxied
}

const origInstantiate = WebAssembly.instantiate
WebAssembly.instantiate = function (...args) {
  const r = origInstantiate.apply(this, args)
  return r && typeof r.then === 'function' ? r.then(capture) : capture(r)
}
if (WebAssembly.instantiateStreaming) {
  const origStreaming = WebAssembly.instantiateStreaming
  WebAssembly.instantiateStreaming = function (...args) {
    return origStreaming.apply(this, args).then(capture)
  }
}
// The synchronous `new WebAssembly.Instance` path is not wrapped. If the
// library used it, wasmMemory stays null and every arm reports FAILED rather
// than reporting a wrong number.

// --- Potree, verbatim -----------------------------------------------------
importScripts('/libs/copc/index.js')

// EptLaszipDecoderWorker.js ends with `onmessage = readUsingDataView`, so after
// this import self.onmessage IS Potree's decode entry point.
importScripts('/src/workers/EptLaszipDecoderWorker.js')
const potreeDecode = self.onmessage
if (typeof potreeDecode !== 'function') throw new Error('potree worker did not set onmessage')

// Potree's worker posts the decoded buffers per node. Swallow them — they are
// JS-heap ArrayBuffers and cannot move a wasm metric either way — but count
// them, so a silently-skipped decode cannot masquerade as a clean arm.
let decodes = 0
const realPostMessage = self.postMessage.bind(self)
self.postMessage = () => {
  decodes++
}

/** Message exactly as EptLaszipLoader.parse() builds it (isFullFile: true) —
 *  Potree's classic EPT path, one whole ept-data/<key>.laz per node. */
async function buildFileMessage(compressed) {
  const { Las } = Copc
  const get = (begin, end) => new Uint8Array(compressed, begin, end - begin)
  const header = Las.Header.parse(new Uint8Array(compressed))
  const vlrs = await Las.Vlr.walk(get, header)
  let eb = []
  const ebVlr = Las.Vlr.find(vlrs, 'LASF_Spec', 4)
  if (ebVlr) eb = Las.ExtraBytes.parse(await Las.Vlr.fetch(get, ebVlr))
  return { isFullFile: true, compressed, header, eb, pointCount: header.pointCount, nodemin: [0, 0, 0] }
}

/** Message exactly as CopcLaszipLoader.load()/parse() builds it
 *  (isFullFile: false) — a genuine COPC node slice with that node's own point
 *  count. It MUST be a real chunk: handing decompressChunk a whole file with
 *  the file's point count makes it decode the file as one chunk, ask for 2.7 GB
 *  and abort the worker. That is a broken probe, not a finding. */
async function buildChunkMessage(bytes) {
  const { Copc: C } = Copc
  const getter = async (begin, end) => new Uint8Array(bytes.slice(begin, end))
  const copc = await C.create(getter)
  const { nodes } = await C.loadHierarchyPage(getter, copc.info.rootHierarchyPage)
  const key = Object.keys(nodes).find((k) => nodes[k] && nodes[k].pointCount > 0)
  if (!key) throw new Error('fixture has no COPC node with points')
  const n = nodes[key]
  return {
    isFullFile: false,
    compressed: bytes.slice(n.pointDataOffset, n.pointDataOffset + n.pointDataLength),
    header: copc.header,
    eb: copc.eb,
    pointCount: n.pointCount,
    nodemin: [0, 0, 0],
  }
}

// Every throw below is reported back as data. A rejection from an async
// onmessage handler does NOT reach Worker.onerror, so without this a violated
// invariant would hang the page silently instead of failing loudly — the worst
// outcome for someone else running this.
self.onmessage = (e) =>
  runArm(e).catch((err) => realPostMessage({ error: String((err && err.message) || err) }))

const runArm = async (e) => {
  const { url, iterations, warmup, arm } = e.data
  const bytes = await (await fetch(url)).arrayBuffer()

  // Returns the COMPRESSED bytes this call actually decoded, so each arm's
  // `fed` is its own input size. Counting the whole fixture for both arms (an
  // earlier bug here) makes the control's denominator, and its ratio, wrong.
  const run = async () => {
    const msg = arm === 'chunk' ? await buildChunkMessage(bytes) : await buildFileMessage(bytes.slice(0))
    await potreeDecode({ data: msg })
    return msg.compressed.byteLength
  }

  // laz-perf grows its heap several MB on first use and its allocator settles
  // into a steady state. The warmup is common-mode — both arms get the same
  // one, and every number below is a between-arm comparison — so it cannot
  // manufacture a difference. It can only UNDER-report the leaking arm, since
  // the warmup's own leaked bytes fall outside the measured window.
  for (let i = 0; i < warmup; i++) await run()

  const heapBefore = wasmMemory ? wasmMemory.buffer.byteLength : null
  const outstandingBefore = outstanding
  const mallocBefore = mallocCalls
  const freeBefore = freeCalls
  const decodesBefore = decodes
  let fed = 0

  for (let i = 0; i < iterations; i++) fed += await run()

  const decodesDone = decodes - decodesBefore
  // Enforced, not merely displayed: a skipped decode would otherwise look
  // exactly like a clean arm.
  if (decodesDone !== iterations)
    throw new Error(`arm ${arm}: ${decodesDone} decodes for ${iterations} iterations`)

  realPostMessage({
    arm,
    iterations,
    fed,
    decodes: decodesDone,
    outstandingLeaked: outstanding - outstandingBefore,
    mallocs: mallocCalls - mallocBefore,
    frees: freeCalls - freeBefore,
    heapBefore,
    heapAfter: wasmMemory ? wasmMemory.buffer.byteLength : null,
  })
}
