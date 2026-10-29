// Fractional indexing over printable ASCII (" ".."~"). Keys compare with plain
// string comparison, so siblings can be reordered by rewriting a single key.
//
// Real .fig files use space as a digit (e.g. position " }" observed in
// fixtures/sample.fig), so the alphabet starts at 0x20.
//
// Keys are base-95 fractions in [0, 1); a key never ends in the zero digit " "
// (otherwise "a" and "a " would be equal and no key would fit between them).

const DIGITS = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
const ZERO = DIGITS[0]!;

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

function validate(key: string): void {
  if (key === "" || key.endsWith(ZERO) || [...key].some((c) => !DIGITS.includes(c))) {
    throw new Error(`invalid fractional key ${JSON.stringify(key)}`);
  }
}

/** Returns a key strictly between `a` and `b` (null = open end). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween: expected a < b, got ${JSON.stringify(a)} >= ${JSON.stringify(b)}`);
  }
  return midpoint(a ?? "", b);
}

/** `n` keys in ascending order between `a` and `b`. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  const keys: string[] = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, b);
    keys.push(prev);
  }
  return keys;
}
