# M2 contract notes — rc-parity (test/parity/rc-recorder, docs/PARITY-RC.md)

No src/ file was touched. The suite runs green; one finding is a `test.todo` with a failing body.
Run it with `bun test --todo test/parity/rc-recorder` to see the failure.

## 1. Suspected importer gap: RoleCall export pins (`injection_position` 4 / 3) — formats agent

Failing test: `test/parity/rc-recorder/rc-parity.test.ts` →
`RoleCall parity: presets > 08, pins: RoleCall export pins import as top/bottom pins in injection_order` (todo).

- A RoleCall export (`extensions.rolecall`) writes RoleCall's own placements as they are. RoleCall's
  export route uses `normalizeInjectionPosition`, and presets-core types them as
  `0 relative, 1 in-chat, 2 append, 3 append-bottom (very end), 4 prepend-top (very start)`.
- RoleCall sorts each pin group by `injection_order` and ignores declaration order. Fixture 08
  declares D,B,A,C and B,C,A; the recording sends A,B,C,D and A,B,C.
- `stPresetToPreset` places 2, 3 and 4 `relative` with `unknown_position`. For an ST file that is
  right. For an RC export, D-71 says to read it "with RoleCall's rules", and core.preset/1 has
  `at: 'top'` and `at: 'bottom'` for exactly these two. §19.3 lists only "08 — append" as a named
  deviation, not the pins.
- Today the bottom pins land above the chat, and both groups keep declaration order.
- Suggested rule, for RC exports only: 4 → `'top'`, 3 → `'bottom'`, each group stable-sorted by
  `injection_order`. `top` and `bottom` blocks are laid out apart from relative ones, so moving them
  in `blocks` changes nothing else. After that the todo passes as it is; flip it to `test()`.

## 2. Question: RoleCall appends (`injection_position` 2) in an RC export — formats agent / integrate

- RoleCall glues an append onto the d-th last chat message of its role, with system falling back to
  user (`appendAtDepth`). The core has no append placement, so this is named deviation RC-8 in
  docs/PARITY-RC.md.
- The importer places such a block relative, with its own role. Fixture 08 therefore sends a stray
  `user` "APPEND-USER-DEPTH0" and an `assistant` "APPEND-ASSISTANT-DEPTH1" message in the frame,
  before the greeting. A user or assistant message at that spot reads to the model as chat.
- Suggestion: for RC exports, import appends **disabled**, with a warning that names the placement.
  Nothing unexpected is sent, and the user can turn the block on or move it.
- The parity test strips the append blocks either way, so it passes under both readings.

## 3. Question: template formats in real RoleCall exports — formats agent / integrate

- RoleCall's export route always writes `wi_format`, `scenario_format` and `personality_format`. With
  no stored value it writes its defaults: `"[{{char}}'s personality: {{personality}}]"`, `"{{scenario}}"`
  and `"[Details of the fictional world the RP is set in:\n{0}]"`.
- RoleCall's assembler at the pin never applies any of them. Neither does Bunraku (D-70).
- The importer maps them to `Preset.formats`, and assemble then applies them. A real RoleCall preset
  imported into rp-core therefore gains a `[Vera's personality: …]` wrapper that RoleCall never sent.
- The parity converter leaves the formats out, because the fixture rows carry none. So the suite
  does not show this; it is recorded in docs/PARITY-RC.md ("Converter").
- Options:
  - (a) For RC exports, keep the three formats in `extras` and do not apply them, since RoleCall's
    rules apply them nowhere.
  - (b) Keep the current behaviour and name it a D-70 deviation.
- I lean to (a). It needs a decision, so no failing test was added.
