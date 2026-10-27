# M3 provenance rows — memory agent

| Core file | Source | Commit | Verdict | What changed |
|---|---|---|---|---|
| `src/agents/compendium/apply.ts` | Bunraku:src/core/compendium/relationships.ts (`normalizeName`, line 39; Coneja-Chibi, commit 9317c3d3) | 702d8120 | adapt | One function. Kept: locale-free lower case, every non-name character to a space, whitespace collapsed, trimmed. Changed (D-95, a named change of a ported function, because note keys built with it are persisted in `mem` rows): NFKC first, ё→е after lower-casing, `\p{M}` kept in the class (D-46: a stress mark or other non-composing combining mark no longer splits a word), and '' for a result with no letter or digit (a lone mark is not a name). The fold around it (`foldCompendium`: path filter, seq order, note/edit/retire/restore over notes, `#n` key allocation, issues for file/arc/revert, rev hash) is fresh code after §5.8; Bunraku's `findMatch`/`mergeData`/staging are not used in M3 (M5a). |
| `src/agents/compendium/notes.ts` | — | — | fresh | The notes lore book, `C<n>` handles and ref resolution are new (§5.8 "Заметки"). The title rule of `resolveNoteRef` compares normalized names like Bunraku's `entryNames` (snapshot.ts, Coneja-Chibi), but no code is taken. |

No RoleCall code was ported here, so the 660a7d67a import caveat does not apply.
