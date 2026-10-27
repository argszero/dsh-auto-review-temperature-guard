/**
 * Every arm here runs against the **published** `@deepseek-ai/dsh-llm`
 * (0.2.1-rc.3, from the registry), not the source tree: the claim is about what
 * a user's installed runtime does with this plugin mounted, and a reading taken
 * on `packages/` would be a reading of a tree nobody runs.
 *
 * The chain under test is the real one — a real cordis `Context`, the real
 * `LlmRuntime` service, a real adapter registration, and the real `stream`
 * dispatch path (which includes the `llm/stream` waterfall). The adapter is a
 * stand-in only because the wire is not what is being measured: it records the
 * options object that reached it, which is the whole question.
 *
 * The control arm is first and it is the point: with no guard mounted, the same
 * call arrives at the adapter carrying `temperature: 0`, so the defect is
 * reproduced on the artifact rather than restated from the report.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  apply, isReviewerRequest, normalizeConfig, REVIEW_MARKER, withTemperature,
} from '../lib/index.js'

/** One recorded dispatch: what the adapter was handed. */
const received = []

/** An adapter that records its options and stops immediately. */
class RecordingAdapter extends LlmAdapter {
  stream(options) {
    received.push(options)
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** The reviewer request, exactly as `auto-review/src/index.ts:675-681` builds it. */
function reviewerRequest(overrides = {}) {
  return {
    provider: 'mock',
    model: 'kimi-k3',
    system: `${REVIEW_MARKER}A fixed policy follows.`,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'pending call' }] }],
    temperature: 0,
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** An ordinary conversation request: no `system`, its own sampling rate. */
function ordinaryRequest() {
  return {
    provider: 'mock',
    model: 'kimi-k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    temperature: 0.7,
  }
}

/** Mount the real service and a recording adapter; optionally mount the guard. */
async function world(config) {
  received.length = 0
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], new RecordingAdapter())
  const fiber = config === undefined
    ? undefined
    : await ctx.plugin({
      name: 'auto-review-temperature-guard',
      inject: ['llm'],
      apply: (inner, passed) => apply(inner, passed),
    }, config)
  return { ctx, fiber }
}

/** Drive one request to the adapter and hand back what it received. */
async function dispatch(ctx, options) {
  for await (const _chunk of ctx.llm.stream(options)) { /* drain: the adapter records on entry */ }
  return received.at(-1)
}

describe('the defect, reproduced on the published runtime', () => {
  it('hands the reviewer request to the adapter with temperature: 0', async () => {
    const { ctx } = await world(undefined)
    assert.equal((await dispatch(ctx, reviewerRequest())).temperature, 0)
  })
})

describe('the guard, on the reviewer call path', () => {
  it('omits the field, so the route default applies', async () => {
    const { ctx } = await world({})
    const served = await dispatch(ctx, reviewerRequest())
    assert.equal('temperature' in served, false)
    assert.equal(served.temperature, undefined)
  })

  it('sends a configured value when one is given', async () => {
    const { ctx } = await world({ temperature: 1 })
    assert.equal((await dispatch(ctx, reviewerRequest())).temperature, 1)
  })

  it('carries every other field of the request through by reference', async () => {
    const { ctx } = await world({})
    const original = reviewerRequest()
    const served = await dispatch(ctx, original)
    // The reviewer's own messages, tools and signal must be the ones that go
    // out: rebuilding them would change a request this plugin was not asked to
    // change beyond one field.
    assert.equal(served.messages, original.messages)
    assert.equal(served.system, original.system)
    assert.equal(served.provider, original.provider)
    assert.equal(served.model, original.model)
    assert.equal(served.signal, original.signal)
    assert.notEqual(served, original)
  })
})

describe('every other call path is untouched', () => {
  it('passes a conversation request through as the same object', async () => {
    const { ctx } = await world({})
    const original = ordinaryRequest()
    const served = await dispatch(ctx, original)
    // Identity, not deep equality: "byte-identical" is only true if nothing
    // copied the object on the way past.
    assert.equal(served, original)
    assert.equal(served.temperature, 0.7)
  })

  it('leaves a one-shot request alone when its system prompt is not the reviewer policy', async () => {
    const { ctx } = await world({})
    const oneShot = { ...ordinaryRequest(), system: 'You are a summarizer.', temperature: 0 }
    const served = await dispatch(ctx, oneShot)
    assert.equal(served, oneShot)
    assert.equal(served.temperature, 0)
  })

  it('leaves a request that has no system field at all alone', async () => {
    const { ctx } = await world({})
    const bare = { ...ordinaryRequest(), temperature: 0 }
    assert.equal(await dispatch(ctx, bare), bare)
  })
})

describe('observe mode reports without changing the request', () => {
  it('sends temperature: 0 and counts nothing as rewritten', async () => {
    const { ctx } = await world({ mode: 'observe' })
    const original = reviewerRequest()
    const served = await dispatch(ctx, original)
    assert.equal(served, original)
    assert.equal(served.temperature, 0)
  })
})

describe('the shadow is reversible', () => {
  it('restores the unguarded behaviour when the plugin is disposed', async () => {
    const { ctx, fiber } = await world({})
    assert.equal((await dispatch(ctx, reviewerRequest())).temperature, undefined)
    await fiber.dispose()
    // A guard that outlived its own plugin would keep acting in a process where
    // nothing claims to guard anything.
    assert.equal((await dispatch(ctx, reviewerRequest())).temperature, 0)
  })

  it('warns once per mount, naming the route and what it did', async () => {
    const ctx = new Context()
    const logged = []
    ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['mock'], new RecordingAdapter())
    await ctx.plugin({
      name: 'auto-review-temperature-guard', inject: ['llm'], apply: (inner, passed) => { apply(inner, passed) },
    }, {})
    for await (const _ of ctx.llm.stream(reviewerRequest())) { /* one */ }
    for await (const _ of ctx.llm.stream(reviewerRequest())) { /* two: reviewed tools repeat */ }
    const warnings = logged.filter(message => String(message.args[0]).includes('auto-review-temperature-guard:'))
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0].args[0]), /mock\/kimi-k3/)
    assert.match(String(warnings[0].args[0]), /omitted, so the route default applies/)
  })
})

describe('the predicate, and what it does not claim', () => {
  it('matches the reviewer policy marker', () => {
    assert.equal(isReviewerRequest(reviewerRequest()), true)
  })

  it('does not match an absent, different, or merely containing system prompt', () => {
    assert.equal(isReviewerRequest({ provider: 'p', model: 'm', messages: [] }), false)
    assert.equal(isReviewerRequest({ provider: 'p', model: 'm', messages: [], system: 'You are a summarizer.' }), false)
    assert.equal(isReviewerRequest({ provider: 'p', model: 'm', messages: [], system: `see ${REVIEW_MARKER} below` }), false)
  })

  it('normalizes an absent or partial config to the safe default', () => {
    assert.deepEqual(normalizeConfig(), { mode: 'enforce', temperature: undefined })
    assert.deepEqual(normalizeConfig({ mode: 'observe' }), { mode: 'observe', temperature: undefined })
    assert.equal(normalizeConfig({ temperature: 0 }).temperature, 0)
  })

  it('keeps a zero replacement rather than treating it as absent', () => {
    assert.equal(withTemperature(reviewerRequest(), 0).temperature, 0)
    assert.equal('temperature' in withTemperature(reviewerRequest(), undefined), false)
  })

  it('does not mutate the frozen request it was handed', () => {
    const frozen = Object.freeze(reviewerRequest())
    const served = withTemperature(frozen, 1)
    assert.equal(frozen.temperature, 0)
    assert.equal(served.temperature, 1)
  })
})
