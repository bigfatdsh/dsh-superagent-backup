/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig, type Machine } from './deployment.ts'

/** How long a starting process waits for a previous instance to release the state directory before giving up. */
const LOCK_WAIT_MS = 30_000

/**
 * Constructs the Runtime, waiting out a state-directory lock that the previous instance has not released yet.
 * The app can start this Host while the one before it is still closing, and its lock is younger than `stale`, so
 * `proper-lockfile` reports it as held rather than stale. Failing here unloads the whole entry, which leaves the
 * Superagent panel without its Host service for the rest of the run; waiting recovers it as soon as the lock ages out.
 */
async function mount(ctx: Context, machine: Machine, restart: () => void): Promise<Runtime> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      return new Runtime(ctx, machine, restart)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ELOCKED' || Date.now() >= deadline) throw error
      ctx.logger.warn('dsh-superagent: the state directory is locked by another process; retrying: %s',
        error instanceof Error ? error.message : String(error))
      await new Promise(resolve => { setTimeout(resolve, 1_000) })
    }
  }
}

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = await mount(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
