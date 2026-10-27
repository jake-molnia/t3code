const decimalPowers = new Map([
  ["", 0],
  ["n", -9],
  ["u", -6],
  ["m", -3],
  ["k", 3],
  ["K", 3],
  ["M", 6],
  ["G", 9],
  ["T", 12],
  ["P", 15],
  ["E", 18],
]);
const binaryPowers = new Map([
  ["Ki", 10],
  ["Mi", 20],
  ["Gi", 30],
  ["Ti", 40],
  ["Pi", 50],
  ["Ei", 60],
]);
function rational(value: string) {
  if (value.length > 128) return null;
  const match = /^(\d+)(?:\.(\d+))?([a-zA-Z]+|[eE][+-]?\d+)?$/.exec(value);
  if (!match?.[1]) return null;
  const fractional = match[2] ?? "";
  const suffix = match[3] ?? "";
  let numerator = BigInt(match[1] + fractional);
  let denominator = 10n ** BigInt(fractional.length);
  const binary = binaryPowers.get(suffix);
  if (binary !== undefined) numerator *= 2n ** BigInt(binary);
  else {
    const decimal =
      decimalPowers.get(suffix) ??
      (/^[eE][+-]?\d+$/.test(suffix) ? Number(suffix.slice(1)) : undefined);
    if (decimal === undefined || Math.abs(decimal) > 100) return null;
    if (decimal >= 0) numerator *= 10n ** BigInt(decimal);
    else denominator *= 10n ** BigInt(-decimal);
  }
  return { numerator, denominator };
}

/** Kubernetes canonicalizes quantity spelling, including 1000m to 1 and 1024Mi to 1Gi. */
export function sameQuantity(left: string, right: string): boolean {
  const a = rational(left);
  const b = rational(right);
  return a !== null && b !== null && a.numerator * b.denominator === b.numerator * a.denominator;
}
