// Cross-build output check: does a patched copc build decode this fixture to
// EXACTLY the bytes the published copc@0.0.8 does? The leak harness only
// asserts arm A == arm B within one run; this compares arm A across builds.
//
// Run: COPC_MODULE=../copc-pr17.bundle.cjs node node/crossbuild-check.cjs ept-node-real.laz

const fs = require('node:fs')
const crypto = require('node:crypto')
const { createLazPerf } = require('laz-perf')

const FILE = process.argv[2] || 'ept-node-real.laz'
const OTHER = process.env.COPC_MODULE
if (!OTHER) {
  console.error('set COPC_MODULE to the build to compare against copc@0.0.8')
  process.exit(2)
}

const sha = (u8) => crypto.createHash('sha256').update(u8).digest('hex')

;(async () => {
  const raw = fs.readFileSync(FILE)
  const file = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const lazPerf = await createLazPerf() // one shared instance, both builds
  const base = require('copc')
  const other = require(OTHER)
  const h = base.Las.Header.parse(file)
  console.log(`fixture ${FILE}: pointCount ${h.pointCount}, pointDataRecordLength ${h.pointDataRecordLength}`)
  const a = await base.Las.PointData.decompressFile(file, lazPerf)
  const b = await other.Las.PointData.decompressFile(file, lazPerf)
  const ha = sha(a)
  const hb = sha(b)
  console.log(`copc@0.0.8    ${ha}  (${a.length} B)`)
  console.log(`COPC_MODULE   ${hb}  (${b.length} B)`)
  if (ha !== hb) {
    console.error('MISMATCH: the builds decoded different point data')
    process.exit(1)
  }
  console.log('cross-build identical')
})()
