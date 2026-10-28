# @argszero/dsh-auto-review-temperature-guard

`experimental-auto-review` sends a hardcoded `temperature: 0`, and a model that accepts only `temperature: 1`
answers HTTP 400 — after which the pre-tool gate denies **every** tool call. This plugin sends the reviewer
request the way its route can actually serve it, and leaves every other request untouched.

## The gap, exactly

The reviewer reuses the Session's own route and narrows it unconditionally. At
`packages/experimental/auto-review/src/index.ts:675-681` one frozen request is built and sent:

```ts
const options: GenerateOptions = deepFreeze({
  provider: snapshot.provider,
  model: snapshot.model,
  system: REVIEW_POLICY,
  messages: reviewMessages(snapshot),
  temperature: 0,
  signal,
})
return readDecision(ctx.llm.stream(options))
```

On a route whose model fixes its sampling rate, that request fails, and the failure travels:

1. the provider answers `400: invalid temperature: only 1 is allowed for this model`;
2. the adapter turns it into a terminal `finish` chunk with `reason.kind === 'error'`;
3. `readDecision` throws at `:647` (`auto-review: reviewer ended with error INVALID_REQUEST: …`);
4. the gate fails closed, so the tool body never runs and every subsequent call is denied the same way.

The denial text says `Auto review rejected tool "<name>"`, which is the same sentence a genuine denial
produces — so a configuration incompatibility is indistinguishable from a review decision, and the session
simply stops working.

## Why the request can only be corrected where this plugin corrects it

The `llm/stream` waterfall sees the request and can identify it. The harness's own stand-in reviewer does
exactly that (`packages/experimental/auto-review/tests/fixtures/headless-reviewer.ts:20`):

```ts
if (!options.system?.startsWith('REVIEW_POLICY\n')) { yield* next(); return }
```

What the waterfall cannot do is **change** the request: `next()` takes no arguments, and the options object
is deep-frozen at the call site — every listener can only substitute chunks. The request is fixed one step
earlier, in `LlmRuntime.stream` (`packages/llm/llm/src/index.ts:1166`), which is where this plugin
intercepts and rebuilds it.

## What "that call path only" means

The reviewer request is recognised by the **same marker the harness's own fixtures use**:
`system` begins with `REVIEW_POLICY\n`. This is not a heuristic invented here — it is how the project
itself separates a reviewer call from a main-agent call.

`GenerateOptions.system` is documented as one-shot-only ("loop-built requests leave it undefined"), so no
ordinary conversation request can match. A request that does not match is passed through as **the same
object**, not a copy — the test asserts identity (`served === original`), which is the only honest reading
of "byte-identical".

## What it does to that one request

| configuration | what the adapter receives |
|---|---|
| default | `temperature` **omitted** — the route's own default applies |
| `temperature: 1` | `temperature: 1` |
| `mode: observe` | `temperature: 0` unchanged, and one warning |

```yaml
- id: auto-review-temperature-guard
  name: '@argszero/dsh-auto-review-temperature-guard'
  config:
    temperature: 1    # optional; omit to drop the field and let the route decide
```

The warning is emitted once per mount, naming the route and what was done. One reviewer request is one tool
call and the reviewer runs per call, so a per-call warning would be noise.

## What it does not do

- **It does not make a reviewer failure look like a failure.** That is `:647` and its caller — the gate
  converts every reviewer error into a denial in core. This plugin removes the one error the reporter hit;
  it cannot distinguish the next one.
- **It does not stop the reviewer from inheriting the session's route.** The reporter's third suggestion
  (a per-route `supportsTemperature` capability, which `llm-pi-ai` has at
  `packages/llm/llm-pi-ai/src/catalog.ts:452` and the other adapters do not) is a core change; the guard
  works around the symptom, not the missing capability.
- **It matches on a marker, not on an identity.** The marker is a real constant in the shipped package —
  `const REVIEW_POLICY` at `packages/experimental/auto-review/src/index.ts:48`, used as `system` at `:678` —
  and it is **not exported** (the package exports only `name`, `inject` and `apply`), so this guard carries
  its own copy of the literal and cannot import it. If a future auto-review renames the header, the guard
  stops matching and the request goes out unchanged, and nothing in this package is able to notice.
  What the upstream build does provide is a tripwire on its own side: `tests/auto-review.spec.ts:415`
  asserts the request it sends with `system: EXPECTED_REVIEW_POLICY`, so a rename fails that suite before
  the same rename could reach a release — a `REVIEW_POLICY` change is a visible edit upstream, not a silent
  one. `mode: observe` remains how to confirm the match against any new build before trusting it here.
- **It is not the fix.** The fix is one of the reporter's three suggestions, applied in
  `experimental-auto-review` itself. This is what is available today without it.

## Measured

The suite runs against the **published** `@deepseek-ai/dsh-llm@0.2.1-rc.3` from the registry — not the
source tree — with a real cordis `Context`, the real `LlmRuntime` service, a real adapter registration and
the real `dispatch` path including the `llm/stream` waterfall. The adapter is a stand-in only because the
wire is not what is being measured: it records the options object that reached it.

- **Control first:** with no guard mounted, the reviewer request arrives at the adapter carrying
  `temperature: 0` — the defect reproduced on the artifact, not restated from the report.
- With the guard: the field is absent; `messages`, `system`, `provider`, `model` and `signal` are the
  caller's own references; `temperature: 1` and `observe` behave as the table says.
- A conversation request arrives as the **same object** with `temperature: 0.7` intact; a one-shot request
  with a different system prompt, even one carrying `temperature: 0`, is untouched.
- Disposing the plugin restores the unguarded behaviour.

15 arms, all passing.

## Compatibility

Peer ranges, verbatim:

```
@deepseek-ai/dsh-llm    >=0.2.1-rc.3 <0.2.1
@deepseek-ai/cordis     ^4.0.2
```

The `dsh-llm` range is the line the effect was measured on, and it is not wider than that: the seam is
`LlmRuntime.stream` and the marker is `REVIEW_POLICY`, both read at the `0.2.1-rc.3` build that
`packages/experimental/auto-review/package.json` itself declares. `@deepseek-ai/cordis` sits at `^4.0.2`
because its versions do not follow the harness's line numbering.

Note when installing `experimental-auto-review` itself: its `latest` dist-tag points at `0.1.6-alpha.1`,
which is older than the `0.2.1-rc.3` build this reading comes from. Pin the version.

## Install

This package is delivered over git; it is not on the registry.

```sh
dsh plugin --profile <profile> add github:argszero/dsh-auto-review-temperature-guard
```

## License

MIT
