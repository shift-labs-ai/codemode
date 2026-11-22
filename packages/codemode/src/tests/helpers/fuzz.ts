// A seeded source of random values, so that a failing case can be run again.

export interface Random {
  /** A whole number from `min` to `max`, both included. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** Mulberry32: small, fast, and the same on every runtime. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  return {
    int,
    pick: (items) => items[int(0, items.length - 1)],
    chance: (probability) => next() < probability,
  };
}

/** Pieces of text that cutting tends to get wrong. */
const PIECES = [
  "a",
  "word ",
  "0123456789",
  "é",
  "日本語",
  "😀",
  "👨‍👩‍👧",
  "\n",
  "\n\n",
  "\r\n",
  "\t",
  '"',
  "\\",
  "\\n",
  "\u0000",
  "\u2028",
  " ",
  "]",
  "[Showing lines 1-2 of 3 (4B in all).]",
];

/** A text of up to about `maxPieces` pieces, some of them long runs. */
export function randomText(random: Random, maxPieces: number): string {
  let text = "";
  for (let count = random.int(0, maxPieces); count > 0; count--) {
    const piece = random.pick(PIECES);
    text += random.chance(0.1) ? piece.repeat(random.int(2, 400)) : piece;
  }
  return text;
}

/** A value as a run may return it: JSON, nested to `depth`. */
export function randomValue(random: Random, depth: number): unknown {
  const kind = random.int(0, depth > 0 ? 7 : 4);
  if (kind === 0) return randomText(random, 40);
  if (kind === 1) return random.int(-1000, 1000) / random.pick([1, 3, 7]);
  if (kind === 2) return random.chance(0.5);
  if (kind === 3) return null;
  if (kind === 4) return randomText(random, 3);
  if (kind <= 6)
    return Array.from({ length: random.int(0, 12) }, () =>
      randomValue(random, depth - 1),
    );
  return Object.fromEntries(
    Array.from({ length: random.int(0, 8) }, () => [
      randomText(random, 2) || "key",
      randomValue(random, depth - 1),
    ]),
  );
}
