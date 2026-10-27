# M3 provenance — agent `prompt`

No code was ported in this agent's M3 work. Every change is rp-core's own:

| File | Change | Origin |
|------|--------|--------|
| src/prompt/assemble.ts | core block placement and counting, tool room, kept ids, echo gating | own (spec §8.3, §11; decisions C2–C4, D-93) |
| src/prompt/assemble/chat.ts | one text block per history message; DeepSeek reasoning echo | own (decisions C3, C4) |
| src/prompt/shape.ts | echo answers still merge (reasoning kept) | own; the idea is the research note m3-probe-deepseek.md §0 finding 5. The file's existing Bunraku/SillyTavern port header is unchanged and covers the ported parts only |
| src/prompt/tokens.ts | estimateToolSpecs | own |

The core block's text is renderCoreBlock from src/tools/prompted.ts (tools-parse agent; its own
header and provenance row apply).
