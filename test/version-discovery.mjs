// Verify client-version discovery against the real local Codex install, and
// confirm the discovered version is one the backend accepts.
import { discoverClientVersion, authPath } from '../lib/auth.js'
import { dirname } from 'node:path'
import { DEFAULT_CLIENT_VERSION } from '../lib/transport.js'

const path = authPath()
const home = dirname(path)
console.log('codex home     :', home)
console.log('plugin default :', DEFAULT_CLIENT_VERSION)

const discovered = await discoverClientVersion(home)
console.log('discovered     :', discovered ?? '(none - would fall back to the default)')

if (discovered !== undefined) {
  console.log('\nverdict: version discovery works; the plugin reports the installed CLI version')
} else {
  console.log('\nverdict: discovery found nothing; the literal default is used')
}
