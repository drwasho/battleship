import type { ShipTemplate, ShipTypeId } from './types';

export const BOARD_SIZE = 10;

export const SHIPS: ShipTemplate[] = [
  { id: 'scout', name: 'Scout', size: 2, move: 3, gunCount: 1 },
  { id: 'destroyer', name: 'Destroyer', size: 3, move: 2, gunCount: 2 },
  { id: 'cruiser', name: 'Cruiser', size: 3, move: 2, gunCount: 3 },
  { id: 'battleship', name: 'Battleship', size: 4, move: 1, gunCount: 4 },
  { id: 'dreadnought', name: 'Dreadnought', size: 5, move: 1, gunCount: 5 },
];

export const SHIP_BY_ID = Object.fromEntries(SHIPS.map((s) => [s.id, s])) as Record<ShipTypeId, ShipTemplate>;

export const SHIP_COLORS: Record<ShipTypeId, number> = {
  scout: 0x9cadb8,
  destroyer: 0x8f9daa,
  cruiser: 0x7b8d9f,
  battleship: 0x6f7f8f,
  dreadnought: 0x596a7d,
};
