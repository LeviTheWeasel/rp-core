# Contract notes — macros agent (src/prompt/macros.ts, src/prompt/rng.ts)

No signature had to change. Points the prompt/assemble agent should know:

1. **Escaped slot tags.** `\{\{history\}\}` in a block comes out of `block()` as the literal text
   `{{history}}`. If assemble finds structural slots by scanning the *expanded* output, an escaped tag
   would be taken for a real slot. Safer: find slots in the raw block text (e.g. a block whose trimmed
   content `isStructuralSlot`), or split the raw text on slot tags before calling `block()` on the
   pieces. `isStructuralSlot` accepts both `history` and `{{history}}`.
2. **Card "slots" are macros.** §10.2 lists `{{description}}`, `{{personality}}`, `{{scenario}}`,
   `{{persona}}`, `{{examples}}` as slots; the engine expands them as card macros (D-42 templates). If
   assemble wants to wrap lore around them or trace them as their own blocks, it must cut them out of
   the raw text before `block()`. Otherwise `block('{{description}}', 'description')` just works.
3. **No error channel.** `MacroRun` has no `errors()`: when a bound trips (depth > 100, 1 M chars,
   1 M steps per block) the output is cut silently ('' past depth 100). A future `errors()` export
   for the trace would be additive.
4. **`unknown()`** reports only identifier-like names (`foo`, `/if`, `mes.thing`), so a JSON sample
   such as `{{"a": 1}}` stays literal without polluting `trace.macros.unknown`.
5. **Same source twice.** Calling `block()` twice with the same `source` in one run continues that
   source's RNG stream (no repeated draws); other sources are unaffected (D-44).
6. **`{{pick}}` seed** = `mulberry32(hashString([sessionId, source, rawTemplateText, offset].join('\0')))`,
   offset in the normalized text. For a pick inside a card field the template text is the field's raw
   value, so it is stable as long as the field text and the block source are.
7. `varsDiff()` never contains `null` (no delvar in the §10.4 table); values written back to their
   original value are left out. The returned object is a plain object; `__proto__` is an own key.
