You extract a knowledge graph from a single passage of text.

Return the entities the passage mentions and the relationships the passage
**explicitly supports**. You are building a factual index, not summarising.

## Entity types

- `pokemon` — an individual Pokémon species or form (Pikachu, Alolan Raichu)
- `type` — an elemental type (Fire, Ghost, Dragon)
- `move` — an attack or technique (Thunderbolt, Shadow Ball)
- `ability` — a passive ability (Levitate, Static)
- `item` — an object (Thunder Stone, Eviolite)
- `region` — a place (Kanto, Alola, Cerulean Cave)
- `group` — a named collection (Legendary Birds, Eeveelutions, Kanto Starters)

## Relations

Emit only these, in exactly this direction:

| relation | source → target | meaning |
|---|---|---|
| `evolves_into` | pokemon → pokemon | source evolves into target |
| `has_type` | pokemon → type | source is of that type |
| `super_effective_against` | type → type | source deals 2x to target |
| `not_very_effective_against` | type → type | source deals 0.5x to target |
| `no_effect_on` | type → type | source deals no damage to target |
| `learns_move` | pokemon → move | source can learn target |
| `has_ability` | pokemon → ability | source has that ability |
| `found_in` | pokemon → region | source is encountered there |
| `member_of` | pokemon → group | source belongs to that group |
| `regional_variant_of` | pokemon → pokemon | source is a regional form of target |
| `mega_evolves_into` | pokemon → pokemon | source mega evolves into target |

## Rules

1. **Direction matters more than anything else.** "Ghost is weak to Dark" means
   `Dark super_effective_against Ghost` — the *attacker* is the source. Read the
   sentence twice before you pick the direction.
2. **Only what the passage states.** Do not add facts you happen to know about
   Pokémon. A relation you infer from background knowledge is a bug, because it
   will be attributed to this passage as its source.
3. **Every name in `relations` must also appear in `entities`.** Use the exact
   same spelling in both.
4. Use the canonical English name as `name`. Put spelling variants, nicknames,
   and abbreviations the passage actually uses into `aliases`.
5. For `evolves_into`, set `method` to the trigger if the passage names one
   ("Thunder Stone", "level 16", "trade", "high friendship"). Otherwise `null`.
6. Set `confidence` to 1.0 for a directly stated fact, 0.7 if the passage
   implies it, and omit the relation entirely below that. **Skipping an unsure
   relation costs recall; emitting a wrong one produces a confidently wrong
   answer.** Prefer skipping.
7. If the passage supports no relations, return empty arrays. That is a valid
   and common answer for narrative or flavour text.

## Passage

<passage>
{{TEXT}}
</passage>
