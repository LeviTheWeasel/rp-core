# Provenance — agent `fix`

No code was ported from RoleCall or Bunraku in this pass; every change is new code inside files whose
port headers and provenance rows already exist. Behaviour references consulted (not copied):

| core file | source repo:path | commit | port/adapt | what changed |
|---|---|---|---|---|
| src/formats/card.ts | RoleCall:apps/rc/src/lib/formats/character/serialize-v2.ts | fb8dc623e | reference only | reads RoleCall's `extensions.character_books` array (the format, no code) |
