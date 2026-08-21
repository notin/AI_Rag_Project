// ─── Type effectiveness chart (Gen 6+) ──────────────────────────────────────
//
// Ground truth, hand-encoded. Type effectiveness is a multiplier table, and
// prose descriptions of it ("super effective against") are exactly the kind of
// directional fact language models invert on the way back out. These edges are
// written with origin='seed' and confidence 1.0, and they always win a conflict
// against anything extraction produces.
//
// Read as: attacking type -> what it does to the defending types listed.

export const POKEMON_TYPES = [
  'Normal',
  'Fire',
  'Water',
  'Electric',
  'Grass',
  'Ice',
  'Fighting',
  'Poison',
  'Ground',
  'Flying',
  'Psychic',
  'Bug',
  'Rock',
  'Ghost',
  'Dragon',
  'Dark',
  'Steel',
  'Fairy',
] as const;

export type PokemonTypeName = (typeof POKEMON_TYPES)[number];

interface Effectiveness {
  /** 2x damage. */
  double?: PokemonTypeName[];
  /** 0.5x damage. */
  half?: PokemonTypeName[];
  /** 0x damage — immunity. */
  zero?: PokemonTypeName[];
}

export const TYPE_CHART: Record<PokemonTypeName, Effectiveness> = {
  Normal: { half: ['Rock', 'Steel'], zero: ['Ghost'] },
  Fire: {
    double: ['Grass', 'Ice', 'Bug', 'Steel'],
    half: ['Fire', 'Water', 'Rock', 'Dragon'],
  },
  Water: {
    double: ['Fire', 'Ground', 'Rock'],
    half: ['Water', 'Grass', 'Dragon'],
  },
  Electric: {
    double: ['Water', 'Flying'],
    half: ['Electric', 'Grass', 'Dragon'],
    zero: ['Ground'],
  },
  Grass: {
    double: ['Water', 'Ground', 'Rock'],
    half: ['Fire', 'Grass', 'Poison', 'Flying', 'Bug', 'Dragon', 'Steel'],
  },
  Ice: {
    double: ['Grass', 'Ground', 'Flying', 'Dragon'],
    half: ['Fire', 'Water', 'Ice', 'Steel'],
  },
  Fighting: {
    double: ['Normal', 'Ice', 'Rock', 'Dark', 'Steel'],
    half: ['Poison', 'Flying', 'Psychic', 'Bug', 'Fairy'],
    zero: ['Ghost'],
  },
  Poison: {
    double: ['Grass', 'Fairy'],
    half: ['Poison', 'Ground', 'Rock', 'Ghost'],
    zero: ['Steel'],
  },
  Ground: {
    double: ['Fire', 'Electric', 'Poison', 'Rock', 'Steel'],
    half: ['Grass', 'Bug'],
    zero: ['Flying'],
  },
  Flying: {
    double: ['Grass', 'Fighting', 'Bug'],
    half: ['Electric', 'Rock', 'Steel'],
  },
  Psychic: {
    double: ['Fighting', 'Poison'],
    half: ['Psychic', 'Steel'],
    zero: ['Dark'],
  },
  Bug: {
    double: ['Grass', 'Psychic', 'Dark'],
    half: ['Fire', 'Fighting', 'Poison', 'Flying', 'Ghost', 'Steel', 'Fairy'],
  },
  Rock: {
    double: ['Fire', 'Ice', 'Flying', 'Bug'],
    half: ['Fighting', 'Ground', 'Steel'],
  },
  Ghost: { double: ['Psychic', 'Ghost'], half: ['Dark'], zero: ['Normal'] },
  Dragon: { double: ['Dragon'], half: ['Steel'], zero: ['Fairy'] },
  Dark: {
    double: ['Psychic', 'Ghost'],
    half: ['Fighting', 'Dark', 'Fairy'],
  },
  Steel: {
    double: ['Ice', 'Rock', 'Fairy'],
    half: ['Fire', 'Water', 'Electric', 'Steel'],
  },
  Fairy: {
    double: ['Fighting', 'Dragon', 'Dark'],
    half: ['Fire', 'Poison', 'Steel'],
  },
};
