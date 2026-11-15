import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/**
 * Minimal concrete service: a hand-built handle. The seam is spawn-only —
 * defaulting, shell semantics, and deadlines belong to callers — so this stub
 * is all an implementation owes the abstract class.
 */
class StubSubprocessRuntime extends SubprocessRuntime {
  async terminalEnvironment() { return { platform: 'posix' as const } }
  async resolveExecutable(command: string): Promise<string> {
    return `/bin/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const read: SubprocessOutputRead = { text: '', nextOffset: 0, lossy: false }
    const collected = spec.stdio.stdout !== 'pipe' && spec.stdio.stdout !== 'inherit'
      ? { stdout: { readFrom: () => read } }
      : {}
    return {
      control: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return {
      pid: spec.argv.length,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      resize: async () => {},
      inspectActivity: async () => ({ state: 'unknown' as const, revision: 0 }),
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

describe('SubprocessRuntime seam', () => {
  it('a concrete subclass registers as ctx.subprocess and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    const handle = ctx.subprocess.spawn({
      argv: ['true'],
      cwd: '/stub',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 }, stderr: 'inherit' },
      graceMs: 1,
    })
    expect(Object.hasOwn(handle, 'pid')).toBe(false)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
  })

  it('loading a second implementation throws (one subprocess service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    class SecondService extends StubSubprocessRuntime {}
    await expect(ctx.plugin(SecondService)).rejects.toThrow(/service "subprocess" has been registered/)
  })

  it('scrubbedParentEnv drops credential-shaped and DSH_ names (case-insensitively) but keeps PATH', () => {
    process.env.DSH_SCRUB_PROBE = 'stale'
    process.env.dsh_scrub_probe_lower = 'stale'
    process.env.SCRUB_PROBE_TOKEN = 'secret'
    process.env.SCRUB_PROBE_PASSWORD = 'secret'
    process.env.SCRUB_PROBE_PLAIN = 'visible'
    try {
      const env = scrubbedParentEnv()
      expect(env.DSH_SCRUB_PROBE).toBeUndefined()
      expect(env.dsh_scrub_probe_lower).toBeUndefined()
      expect(env.SCRUB_PROBE_TOKEN).toBeUndefined()
      expect(env.SCRUB_PROBE_PASSWORD).toBeUndefined()
      expect(env.SCRUB_PROBE_PLAIN).toBe('visible')
      expect(env.PATH).toBeDefined()
    } finally {
      delete process.env.DSH_SCRUB_PROBE
      delete process.env.dsh_scrub_probe_lower
      delete process.env.SCRUB_PROBE_TOKEN
      delete process.env.SCRUB_PROBE_PASSWORD
      delete process.env.SCRUB_PROBE_PLAIN
    }
  })

  it('appends every standard tool directory after a sparse launchd PATH', () => {
    const originalPath = process.env.PATH
    process.env.PATH = '/usr/bin:/bin'
    try {
      const env = scrubbedParentEnv()
      const entries = env.PATH!.split(delimiter)
      const standard = [
        join(homedir(), '.cargo', 'bin'),
        join(homedir(), '.local', 'bin'),
        ...process.platform === 'darwin'
          ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
          : process.platform === 'win32' ? [] : ['/usr/local/bin', '/usr/local/sbin'],
      ]
      expect(entries.slice(0, 2)).toEqual(['/usr/bin', '/bin'])
      for (const directory of standard) expect(entries).toContain(directory)
      expect(new Set(entries).size).toBe(entries.length)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it('keeps the platform base search path when the parent PATH is absent', () => {
    const originalPath = process.env.PATH
    delete process.env.PATH
    try {
      const entries = scrubbedParentEnv().PATH!.split(delimiter)
      expect(entries).toContain(join(homedir(), '.cargo', 'bin'))
      if (process.platform !== 'win32') expect(entries.slice(0, 2)).toEqual(['/usr/bin', '/bin'])
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it('treats a standard directory with a trailing separator as already present', () => {
    const originalPath = process.env.PATH
    process.env.PATH = `${join(homedir(), '.cargo', 'bin')}/:/usr/bin:/`
    try {
      const entries = scrubbedParentEnv().PATH!.split(delimiter)
      const cargo = entries.filter(entry => entry.replace(/[\\/]+$/, '') === join(homedir(), '.cargo', 'bin'))
      expect(cargo).toHaveLength(1)
      expect(entries).toContain('/usr/local/bin')
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it.skipIf(process.platform === 'win32')('creates uppercase PATH on POSIX even when only a lowercase path is present', () => {
    const originalPath = process.env.PATH
    const originalLower = process.env.path
    delete process.env.PATH
    process.env.path = '/usr/bin'
    try {
      const env = scrubbedParentEnv()
      expect(env.path).toBe('/usr/bin')
      expect(env.PATH?.split(delimiter)).toContain('/usr/bin')
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalLower === undefined) delete process.env.path
      else process.env.path = originalLower
    }
  })
})
