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
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
/** Plugin name, as a loader entry writes it. */
export declare const name = "auto-review-temperature-guard";
/** The service this guard shadows; without it there is nothing to guard. */
export declare const inject: string[];
/** Brand on an installed layer, so a second mount is a no-op. */
export declare const SHADOW_MARK: unique symbol;
/**
 * The first line of the reviewer's fixed policy.
 *
 * Read from the shipped source (`src/index.ts:48` opens the template with the
 * literal `REVIEW_POLICY`) and cross-checked against the harness's own fixture,
 * which identifies the reviewer request the same way.
 */
export declare const REVIEW_MARKER = "REVIEW_POLICY\n";
/** How the guard treats a reviewer request. */
export type GuardMode = 'enforce' | 'observe';
/** What a loader entry may configure. */
export interface GuardConfig {
    /** `enforce` sends the corrected request; `observe` reports and sends `temperature: 0` unchanged. */
    mode?: GuardMode;
    /** Explicit value to send instead of omitting the field. Absent means omit. */
    temperature?: number;
}
/** The guard's resolved settings. */
export interface GuardSettings {
    mode: GuardMode;
    temperature: number | undefined;
}
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
export declare function normalizeConfig(config?: GuardConfig): GuardSettings;
/**
 * Whether one request is the reviewer's.
 * @param options - the options the caller handed to `stream`.
 * @returns true for the reviewer request only.
 */
export declare function isReviewerRequest(options: GenerateOptions): boolean;
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
export declare function withTemperature(options: GenerateOptions, temperature: number | undefined): GenerateOptions;
/**
 * Shadow `stream` so the reviewer's request is served by the route it targets.
 * @param ctx - the plugin context.
 * `apply` returns nothing on purpose: cordis treats a plugin's return value as
 * an effect, so a report object here fails the mount with `Invalid effect`.
 * @param ctx - the plugin context.
 * @param config - whatever the loader entry passed.
 */
export declare function apply(ctx: Context, config?: GuardConfig): void;
//# sourceMappingURL=index.d.ts.map