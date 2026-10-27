/**
 * Give `experimental-auto-review` a sampling parameter its model will accept.
 *
 * The reviewer reuses the Session's own route and narrows it unconditionally:
 * `packages/experimental/auto-review/src/index.ts:675-681` builds one
 * `deepFreeze`d `GenerateOptions` with `temperature: 0` and hands it to
 * `ctx.llm.stream()`. A model that accepts only `temperature: 1` (Kimi K3 and
 * others on OpenAI-compatible routes) answers HTTP 400, the reviewer's stream
 * ends in `error`, `readDecision` throws at `:647`, and the pre-tool gate — which
 * fails closed — then denies **every** tool call. The session stops working and
 * the denial text cannot say why.
 *
 * ## Why the request can only be changed here
 *
 * The `llm/stream` waterfall sees this request and can identify it — the
 * harness's own stand-in reviewer does exactly that
 * (`packages/experimental/auto-review/tests/fixtures/headless-reviewer.ts:20`:
 * `options.system?.startsWith('REVIEW_POLICY\n')`). What the waterfall cannot do
 * is change it: `next()` takes no arguments and the options object is deep
 * frozen at the call site, so every listener can only substitute chunks. The
 * request itself is fixed one step earlier, which leaves `LlmRuntime.stream`
 * on the service instance as the only place a plugin can rewrite it.
 *
 * ## What "that call path only" means here
 *
 * The reviewer request is identified by the same marker the harness's own
 * fixtures use — `system` begins with `REVIEW_POLICY\n`. An ordinary turn leaves
 * `system` undefined (`GenerateOptions.system` is documented as one-shot-only),
 * so no conversation request can match, and a request that does not match is
 * passed through as **the same object**, not a copy. The reviewer's request is
 * the only one whose options change at all.
 *
 * ## What it does to that one request
 *
 * By default the `temperature` field is **omitted**, so the route's own default
 * applies — the same shape the reporter proposed as the smallest fix. Set
 * `temperature` in the config to send a specific value instead.
 *
 * The guard does not repair the two things it cannot reach, and says so rather
 * than implying otherwise: it cannot make the gate distinguish a reviewer
 * *failure* from a reviewer *denial* (that is `:647` and its caller, in core),
 * and it does not stop the reviewer from inheriting the session's route.
 *
 * @module @argszero/dsh-auto-review-temperature-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'

/** Plugin name, as a loader entry writes it. */
export const name = 'auto-review-temperature-guard'

/** The service this guard shadows; without it there is nothing to guard. */
export const inject = ['llm']

/** Key the context files the underlying service instance under. */
const ORIGINAL = Symbol.for('cordis.original')

/** Brand on an installed layer, so a second mount is a no-op. */
export const SHADOW_MARK: unique symbol = Symbol.for('argszero.dsh-auto-review-temperature-guard/stream-shadow')

/**
 * The first line of the reviewer's fixed policy.
 *
 * Read from the shipped source (`src/index.ts:48` opens the template with the
 * literal `REVIEW_POLICY`) and cross-checked against the harness's own fixture,
 * which identifies the reviewer request the same way.
 */
export const REVIEW_MARKER = 'REVIEW_POLICY\n'

/** How the guard treats a reviewer request. */
export type GuardMode = 'enforce' | 'observe'

/** What a loader entry may configure. */
export interface GuardConfig {
  /** `enforce` sends the corrected request; `observe` reports and sends `temperature: 0` unchanged. */
  mode?: GuardMode
  /** Explicit value to send instead of omitting the field. Absent means omit. */
  temperature?: number
}

/** The guard's resolved settings. */
export interface GuardSettings {
  mode: GuardMode
  temperature: number | undefined
}

/** A function carrying the install brand. */
type MarkedFunction = ((...args: never[]) => unknown) & { [SHADOW_MARK]?: true }

/**
 * Resolve the configuration a loader entry may or may not have passed.
 *
 * `mode` defaults to `enforce` because the alternative is the defect: a session
 * whose tools are all denied by a misconfigured reviewer is not a state anybody
 * asked for. `temperature` is unset by default so the route's own default
 * applies, which is the behaviour a model with a fixed sampling rate expects.
 * @param config - whatever the entry passed, or nothing.
 * @returns the resolved settings.
 */
export function normalizeConfig(config: GuardConfig = {}): GuardSettings {
  return {
    mode: config.mode === 'observe' ? 'observe' : 'enforce',
    temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
  }
}

/**
 * Whether one request is the reviewer's.
 * @param options - the options the caller handed to `stream`.
 * @returns true for the reviewer request only.
 */
export function isReviewerRequest(options: GenerateOptions): boolean {
  const system: unknown = options.system
  return typeof system === 'string' && system.startsWith(REVIEW_MARKER)
}

/**
 * The same request with its sampling parameter handled.
 *
 * A new object, because the caller's is deep frozen at the call site — the only
 * alternative would be mutating a value this plugin was never handed. Everything
 * except `temperature` is carried by reference, so the messages, tools and
 * abort signal the reviewer built are the ones that get sent.
 * @param options - the frozen reviewer request.
 * @param temperature - the value to send, or undefined to omit the field.
 * @returns a request the route can serve.
 */
export function withTemperature(options: GenerateOptions, temperature: number | undefined): GenerateOptions {
  const { temperature: _declared, ...rest } = options
  return (temperature === undefined ? rest : { ...rest, temperature }) as GenerateOptions
}

/**
 * The instance `ctx.get('llm')` is a view of.
 *
 * A view is built per read and holds no stable identity, so the property has to
 * be written on the instance behind it: `getTraceable()` files that instance
 * under a `Symbol.for` key, and the context's own property access is the
 * fallback when the service is not traced.
 * @param ctx - the plugin context, with `llm` declared by `inject`.
 * @returns the service instance, or undefined when none is mounted.
 */
function llmInstance(ctx: Context): LlmRuntime | undefined {
  const view = ctx.get('llm') as Record<PropertyKey, unknown> | undefined
  const original = view?.[ORIGINAL]
  if (original !== undefined && original !== null) return original as LlmRuntime
  return ctx.llm as LlmRuntime | undefined
}

/**
 * Shadow `stream` so the reviewer's request is served by the route it targets.
 * @param ctx - the plugin context.
 * `apply` returns nothing on purpose: cordis treats a plugin's return value as
 * an effect, so a report object here fails the mount with `Invalid effect`.
 * @param ctx - the plugin context.
 * @param config - whatever the loader entry passed.
 */
export function apply(ctx: Context, config: GuardConfig = {}): void {
  const settings = normalizeConfig(config)
  // One reviewer request is one tool call, and the reviewer runs per call, so
  // the warning is emitted once per mount rather than once per reviewed tool.
  let announced = false

  ctx.effect(() => {
    const instance = llmInstance(ctx)
    if (instance === undefined) return () => {}
    const current: unknown = instance.stream
    if (typeof current !== 'function') return () => {}
    if ((current as MarkedFunction)[SHADOW_MARK] === true) return () => {}

    const declared = current as (options: GenerateOptions) => AsyncIterable<unknown>
    const hadOwn = Object.prototype.hasOwnProperty.call(instance, 'stream')
    const previous = Object.getOwnPropertyDescriptor(instance, 'stream')

    const layer = function guardedStream(
      this: unknown,
      options: GenerateOptions,
    ): AsyncIterable<unknown> {
      if (!isReviewerRequest(options)) {
        // Not the reviewer: the caller's own object, unchanged and unexamined
        // beyond the one field this guard reads.
        return Reflect.apply(declared, instance, [options])
      }
      const beside = settings.mode === 'observe'
      if (!announced) {
        announced = true
        const outcome = beside
          ? 'left as sent'
          : settings.temperature === undefined
            ? 'omitted, so the route default applies'
            : `set to ${settings.temperature}`
        ctx.logger.warn(
          `auto-review-temperature-guard: the reviewer request for ${options.provider}/${options.model}`
          + ' carried temperature: 0, which a model with a fixed sampling rate rejects with HTTP 400;'
          + ` the field was ${outcome}.`
          + (beside ? ' Observe mode: the request was not changed.' : ''),
        )
      }
      const served = beside ? options : withTemperature(options, settings.temperature)
      return Reflect.apply(declared, instance, [served])
    } as MarkedFunction
    layer[SHADOW_MARK] = true

    try {
      Object.defineProperty(instance, 'stream', {
        value: layer, writable: true, enumerable: false, configurable: true,
      })
    } catch {
      // A sealed instance keeps the defect; it is not a reason to fail the mount.
      return () => {}
    }
    if ((instance as { stream?: unknown }).stream !== layer) return () => {}

    let installed = true
    return (): void => {
      if (!installed) return
      installed = false
      // Only unwind a shadow that is still ours: a later plugin may have
      // wrapped `stream` too, and undoing that would write a third party's state.
      if ((instance as { stream?: unknown }).stream !== layer) return
      if (hadOwn && previous !== undefined) Object.defineProperty(instance, 'stream', previous)
      else delete (instance as { stream?: unknown }).stream
    }
  })
}
