# SafeSpend tool world compatibility shim

This directory preserves ZeroClaw's `zeroclaw:plugin@0.1.0` tool exports while
omitting the optional structured-logging import from the component world.

The pinned official ZeroClaw host can discover a component built from the
upstream world, but its current tool linker does not provide a matching
`zeroclaw:plugin/logging@0.1.0` instance at runtime. SafeSpend does not need
plugin-originated logging for authorization or audit correctness; ZeroClaw
records host-side tool lifecycle events. Keeping this minimal world separate
leaves the vendored upstream WIT in `wit/v0/` unchanged and makes the
compatibility decision explicit.
