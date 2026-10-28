# RoleCall import contract — unit `director` (D-190)

Files: `src/agents/director/import-rc.ts` (new, pure), `test/rcimport/director.test.ts` (new, 23 tests).
Green: `test/rcimport/director.test.ts`, `test/purity.test.ts`; `bunx tsc --noEmit -p .`: nothing in these
files. No other file touched; zero new dependencies. Checked against the real export's dm-contexts with a
throw-away script (removed): every one maps, fits 32 KB and passes checkRecord in well under 50 ms.

## API

```ts
dmContextToState(raw: unknown, opts: { turn: number; turnAt?: (iso: string) => number | undefined })
  → { state: DirectorState | null; analysis?: PlanningAnalysis; warnings: ImportWarning[] }
directorRecordsFor(state: DirectorState, turn: number, opts?: { analysis?; model?; beforeTurn? })
  → { head: DirectorRecord; before?: DirectorRecord }
directorSettingsFor(chatConfig: unknown)
  → { director: { enabled: boolean; style?: PersonalityId }; model?: string; warnings: ImportWarning[] }
```

- `opts.turn`: the user messages on the path up to the head reply (D-190). Bad/negative → 0.
- `opts.turnAt` (optional, recommended): maps an ISO time to "user messages sent up to it". With it an
  arc's / hidden arc's / chapter's `createdAt` dates its creation and a visible arc stage's `timestamp`
  dates the stage. Without it the context's own turn stamps bound them (below). The importer can build
  it from the chat's user-message timestamps (a sorted list + count); src stays clock-free.
- `state: null` only when the dm-context is not an object (`rc_director_unreadable`): store no `dir`.
- `analysis`: RoleCall's `recentAnalysis` entry of `turn` (whatHappened, seedsPlanted, seedsPayedOff →
  seedsPaidOff, unexpectedDevelopments → unexpected), absent when that entry is empty or missing.
- Records: `head` (turn `turn`; `directive` = RoleCall's lastDirective when `lastDirectiveTurn === turn`,
  the authored one — RoleCall keeps no enriched copy) goes on the head reply; `before` (turn
  `beforeTurn ?? turn − 1`, never ≥ turn; state without a lastDirective later than its turn; no analysis)
  goes on the assistant message a replan of the head reply walks to (the head's parent's nearest
  assistant ancestor). Both `ok: true`, `attempts: []`, `skipped` = fitState's, `reducer: 1`, returned as
  `checkRecord` reads them back (round-trip equal). Effect: next reply plans `turn + 1`; a plain swipe of
  the head reuses RoleCall's directive (D-104); a replan plans `turn` again from RoleCall's state. Throws
  only for a state checkState refuses (i.e. not one dmContextToState produced).
- `directorSettingsFor`: RoleCall chat page rule `dmMode ? dmMode === 'full' : !!dmEnabled` ('off',
  'tv_only' → off); `style` = `dmPersonality` when in DIRECTOR_PERSONALITIES (else `rc_director_style`);
  `model` = `rolecall:<dmModelId>` (for the records' `model`). Profile not mapped (RoleCall has no lite
  DM; the session keeps 'auto').

## Mapping choices

- Ids: chapters `chapter-<number>` (RoleCall number kept when whole ≥ 1 and free, else next after the
  max); arcs, seeds, hidden arcs from one counter in that order, made consecutive after the cut;
  `nextId` past them. References: `arc.chapterId` and `currentChapterId` through RoleCall's own rules
  (`repairChapterIdentities` keeper for a shared id: last not complete, else last;
  `resolveCurrentChapterId`: pointer, else last not complete, else last); `seed.relatedArcId` by
  RoleCall id, then `matchArc` (title); unknown → dropped and counted; a link to an arc the limits cut
  is dropped.
- Malformed rows: bare strings and strings spread into `{"0": …}` objects are skipped in every kept
  collection except `nextIntentions` (text → description with plan.ts defaults). A missing title skips
  an arc (unless `recoverArcTitleFromId` gives one) or hidden arc; a missing hint skips a seed. Unknown
  enum values → RoleCall's new-item defaults (arc seeding/background/side/medium; seed player/medium;
  hidden background/medium/world/seeding). Legacy hidden rows: `arcTitle` read as title, a visible-arc
  status mapped (climax/resolution → approaching_player, complete/abandoned → resolved). A `planned`
  chapter is dropped unless it is the current one (then active).
- Turn stamps (all held to `turn`; later ones counted in `rc_director_turn`): a visible arc's
  `stages[].turn` and `turnsActive` are RoleCall update counts, not turns (DMStreamService), so stage
  turn = `createdAtTurn + count` (or turnAt(timestamp)). Arc `createdAtTurn` (RoleCall has none):
  turnAt(createdAt), else the newest its stamps allow — min(turn − turnsActive, lastProgressTurn,
  beat planned/delivered) — but not before its chapter began. Live arc without `lastProgressTurn` →
  `turn` (RoleCall migrateContext does the same on load); finished → absent. Seed `plantedAtTurn` 0 or
  none → `seed_<t>_<n>` id turn, else earliest reinforcement / payoff turn, else `turn`
  (backfillSeedPlantedAtTurn + two bounds). Hidden `createdAtTurn` → turnAt(createdAt), else min of
  `iarc_<t>_<n>` id turn, turn − turnsActive, stage and clue turns. Chapter `createdAtTurn` missing →
  turnAt(createdAt), first chapter 0, else max(earlier chapters, min(next chapter, turn − turnsElapsed)).
- Dropped with one `rc_director_dropped` each: hiddenEvents, npcOffScreenActions, parallelTimelines,
  coreMemories, **notes** (RoleCall's are the DM's own; the core's prompt reads `notes` as "Notes from
  the player" and never evicts them), characterSecrets, worldState, recentAnalysis (all but the head
  turn's). Per-item details (planned beats, involved characters, stage/reinforcement descriptions,
  chapter arc lists/journeys…) → one `rc_director_details`. storyHealth, sessionId, updatedAt silently.
- Limits: D-61 live caps first (24 arcs, 32 seeds, 12 hidden; oldest out by fitState's keys), then
  `fitState`. A person's (`userAuthored`) hidden arcs keep their flag while it fits; if fitState reports
  `fit:over-cap` the flag is dropped and the state refitted (they are then the Director's, evictable).
  One `rc_director_fit` warning: kept counts and the limit/fit steps that ran.
- Warning codes: `rc_director_unreadable`, `rc_director_skipped`, `rc_director_coerced`,
  `rc_director_derived`, `rc_director_refs`, `rc_director_turn`, `rc_director_details`,
  `rc_director_dropped`, `rc_director_fit`, `rc_director_style`. Paths `dm-context.<key>` (ImportWarning).

## Not done here (integrator)

- Writing the records into the journal (`msg.dir` on the head reply and the reply before it) and the
  session's `director` config from `directorSettingsFor` (D-190's "enabled when the chat had it on").
- RoleCall's load-time arc dedup (`dedupActiveArcs`) and shadow-world stage dedup are not ported.

## Open questions

1. RoleCall DM notes are dropped (see above). Alternatives: Compendium notes, or a core change so the
   Director can hold its own notes.
2. Should the importer pass `turnAt`? With it, ages of long-lived arcs come out much older than the
   stamp-only bound (which never overstates an age); live arcs' staleness is anchored at the import
   either way.

## Review fixes (fix-core)

- fidelity#3: the plan puts `recs.head` on every version (swipe sibling) of the head reply and
  `recs.before` on every version of the reply before it (`PlannedSession.director.records` counts them),
  so continuing from another RoleCall version starts from RoleCall's state, not an empty one.
- robust#7: a hidden arc's legacy status is looked up with `Object.hasOwn(HIDDEN_FROM_ARC, …)`; a status
  `__proto__` / `constructor` / `toString` reads as RoleCall's default (`seeding`, coerced warning).
- Tests: director.test.ts "the review fixes" (2).
