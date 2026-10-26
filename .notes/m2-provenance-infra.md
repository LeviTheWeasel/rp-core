# Provenance — infra agent (M2)

No ported code. src/providers/record.ts, the `wire()` method in src/providers/openai-chat.ts and
test/record/*.test.ts are fresh rp-core code (the replay side follows rp-core's own scripted
provider, src/providers/scripted.ts). The test helpers imported from test/adapter/kit.ts are
existing rp-core code. No PROVENANCE.md row is needed.
