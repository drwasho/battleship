import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/engine/rng';
import {
  canMoveShip,
  placeShip,
  randomFleetPlacement,
  resolveMovement,
  resolveShot,
  shipAt,
} from '../src/engine/rules';
import { createInitialState } from '../src/engine/state';

describe('rules engine', () => {
  it('validates placement bounds and overlap', () => {
    const state = createInitialState('2p');
    const p = state.players[0];
    const scout = p.ships.find((s) => s.typeId === 'scout')!;
    const destroyer = p.ships.find((s) => s.typeId === 'destroyer')!;

    expect(placeShip(p, scout.uid, { x: 9, y: 9 }, 'H')).toBe(false);
    expect(placeShip(p, scout.uid, { x: 8, y: 9 }, 'H')).toBe(true);
    expect(placeShip(p, destroyer.uid, { x: 7, y: 9 }, 'H')).toBe(false);
    expect(placeShip(p, destroyer.uid, { x: 0, y: 0 }, 'V')).toBe(true);
  });

  it('validates movement range and blocking', () => {
    const state = createInitialState('2p');
    const p = state.players[0];
    const scout = p.ships.find((s) => s.typeId === 'scout')!;
    const destroyer = p.ships.find((s) => s.typeId === 'destroyer')!;

    placeShip(p, scout.uid, { x: 1, y: 1 }, 'H');
    placeShip(p, destroyer.uid, { x: 5, y: 1 }, 'V');

    expect(canMoveShip(state, 0, { shipUid: scout.uid, to: { x: 4, y: 1 }, orientation: 'H' })).toBe(false);
    expect(canMoveShip(state, 0, { shipUid: scout.uid, to: { x: 2, y: 2 }, orientation: 'V' })).toBe(true);
  });

  it('applies firing damage and supports destruction', () => {
    const state = createInitialState('2p');
    const p1 = state.players[0];
    const p2 = state.players[1];
    const cruiser = p1.ships.find((s) => s.typeId === 'cruiser')!;
    const scout = p2.ships.find((s) => s.typeId === 'scout')!;

    placeShip(p1, cruiser.uid, { x: 0, y: 0 }, 'H');
    placeShip(p2, scout.uid, { x: 2, y: 2 }, 'H');

    const first = resolveShot(state, 0, cruiser.uid, { x: 2, y: 2 });
    expect(first?.hit).toBe(true);
    expect(scout.hp).toBe(1);

    const second = resolveShot(state, 0, cruiser.uid, { x: 2, y: 2 });
    expect(second?.sunkShipUid).toBe(scout.uid);
    expect(scout.sunk).toBe(true);
    expect(shipAt(p2, { x: 2, y: 2 })).toBeUndefined();
  });

  it('resolves simultaneous movement and rejects overlap', () => {
    const state = createInitialState('2p');
    const p1 = state.players[0];
    const p2 = state.players[1];
    const s1 = p1.ships.find((s) => s.typeId === 'scout')!;
    const s2 = p2.ships.find((s) => s.typeId === 'scout')!;

    placeShip(p1, s1.uid, { x: 0, y: 0 }, 'H');
    placeShip(p2, s2.uid, { x: 0, y: 3 }, 'H');

    const result = resolveMovement(
      state,
      [{ shipUid: s1.uid, to: { x: 0, y: 1 }, orientation: 'H' }],
      [{ shipUid: s2.uid, to: { x: 0, y: 1 }, orientation: 'H' }]
    );

    expect(result.rejected).toContain(s1.uid);
    expect(result.rejected).toContain(s2.uid);
    expect(s1.anchor).toEqual({ x: 0, y: 0 });
    expect(s2.anchor).toEqual({ x: 0, y: 3 });
  });

  it('creates random legal AI fleet placements', () => {
    const state = createInitialState('1p');
    randomFleetPlacement(state.players[1], new SeededRng(3));
    expect(state.players[1].ships.every((s) => s.placed)).toBe(true);
  });
});
