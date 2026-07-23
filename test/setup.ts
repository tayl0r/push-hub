// test/setup.ts — per-file setup (vitest setupFiles): runs in each test file's worker and
// shares its module registry, so this `register` IS the instance the file under test uses.
// Every test starts with zeroed metric values; test files never add their own reset.
import { beforeEach } from 'vitest'
import { register } from '../src/metrics.js'

beforeEach(() => { register.resetMetrics() })
