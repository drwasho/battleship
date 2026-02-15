export class SeededRng {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  next(): number {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: T[]): T {
    return items[this.int(items.length)]!;
  }
}
