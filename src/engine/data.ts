import type { ShipTemplate } from './types';

export const BOARD_SIZE = 10;

export const GUN_DAMAGE = {
  light: 1,
  medium: 2,
  heavy: 3,
} as const;

export const SHIPS: ShipTemplate[] = [
  { id: 'scout', name: 'Scout', size: 2, maxHp: 3, move: 3, guns: [{ type: 'light', count: 1 }] },
  { id: 'destroyer', name: 'Destroyer', size: 3, maxHp: 6, move: 2, guns: [{ type: 'light', count: 2 }] },
  { id: 'cruiser', name: 'Cruiser', size: 3, maxHp: 8, move: 2, guns: [{ type: 'medium', count: 1 }] },
  { id: 'battleship', name: 'Battleship', size: 4, maxHp: 12, move: 1, guns: [{ type: 'medium', count: 2 }] },
  { id: 'dreadnought', name: 'Dreadnought', size: 5, maxHp: 18, move: 1, guns: [{ type: 'heavy', count: 1 }] },
];

export const SHIP_BY_ID = Object.fromEntries(SHIPS.map((s) => [s.id, s])) as Record<string, ShipTemplate>;

export const SHIP_COLORS: Record<string, number> = {
  scout: 0x9cadb8,
  destroyer: 0x8f9daa,
  cruiser: 0x7b8d9f,
  battleship: 0x6f7f8f,
  dreadnought: 0x596a7d,
};
