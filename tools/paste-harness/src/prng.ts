export type SeedInput = number | string;

export class SeededPrng {
  private state: number;

  constructor(seed: SeedInput) {
    this.state = hashSeed(seed);
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  int(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) {
      throw new Error(`invalid random range ${minInclusive}..${maxInclusive}`);
    }
    const width = maxInclusive - minInclusive + 1;
    return minInclusive + (this.nextUint32() % width);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("cannot pick from an empty list");
    }
    return items[this.int(0, items.length - 1)] as T;
  }
}

export function hashSeed(seed: SeedInput): number {
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === 0 ? 0x9e3779b9 : hash;
}
