# Specific runtime adapters

This directory is intentionally empty.

Spec §17 is emphatic that Herdr already normalizes the executable, detection,
readiness and (for many integrations) session identity — adapters are
exceptions to `default-adapter.ts`, not the architecture. Adding one here
pads out the codebase without buying correctness, and it is the exact
anti-pattern spec §18 warns about ("launch failed → inspect `--help` → try
random flags").

## The bar for adding one

Add a specific adapter to this directory only when **all** of the following
hold:

1. There is a concrete, cited piece of evidence for the difference — a line
   in `docs/herdr-contract.md`, an entry in `tests/fixtures/herdr/*.json`, or
   an observed Herdr error code/behavior — not a recollection of what some
   CLI's `--help` output looks like from training data.
2. The default adapter's behavior is demonstrably wrong for that runtime kind
   (not just "could be more specific").
3. The fix is expressible as one or two overridden hooks via
   `composeAdapter(defaultRuntimeAdapter, { kind, ...override })`
   (`../registry.ts`) — if it needs the whole interface reimplemented, that
   is itself a sign the "difference" is being invented rather than found.

At the time this package was implemented, the available evidence
(`docs/herdr-contract.md`, `tests/fixtures/herdr/schema.json`,
`agent-manifests.json`, `session-snapshot.json`) contained no runtime-specific
launch recipe, model-selection flag, blocker text, or peer-message format
that the default adapter gets wrong for any of the observed kinds. So: no
adapter is registered here, and `registry.ts` is constructed with an empty
specific-adapter list, falling back to `default-adapter.ts` for every kind.

If a future change adds a specific adapter, register it in the
`RuntimeAdapterRegistry` construction (wherever the app wiring lives) — this
directory holds the adapter modules themselves, not the registration.
