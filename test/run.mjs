// Runs every offline test file in sequence and aggregates the result.
import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const files = (await readdir(here))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

let failed = 0

for (const file of files) {
  console.log(`\n${'='.repeat(60)}\n${file}\n${'='.repeat(60)}`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit' })
    child.on('exit', (c) => resolve(c ?? 1))
  })
  if (code !== 0) failed++
}

console.log(`\n${'='.repeat(60)}`)
console.log(failed === 0 ? `ALL ${files.length} TEST FILES PASSED` : `${failed} of ${files.length} TEST FILES FAILED`)
process.exit(failed === 0 ? 0 : 1)
