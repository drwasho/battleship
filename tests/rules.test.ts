import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/engine/rng';
import {
  canShipFire,
  canMoveShip,
  hasUnfiredShips,
  nextFiringPlayer,
  placeShip,
  randomFleetPlacement,
  resolveMovement,
  resolveSalvo,
  resetFiringRound,
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

    expect(canMoveShip(state, 0, { shipUid: scout.uid, to: { x: 6, y: 1 }, orientation: 'H' })).toBe(false);
    expect(canMoveShip(state, 0, { shipUid: scout.uid, to: { x: 2, y: 2 }, orientation: 'V' })).toBe(true);
  });

  it('applies segment hits and supports destruction', () => {
    const state = createInitialState('2p');
    const p1 = state.players[0];
    const p2 = state.players[1];
    const destroyer = p1.ships.find((s) => s.typeId === 'destroyer')!;
    const scout = p2.ships.find((s) => s.typeId === 'scout')!;

    placeShip(p1, destroyer.uid, { x: 0, y: 0 }, 'H');
    placeShip(p2, scout.uid, { x: 2, y: 2 }, 'H');

    const salvo = resolveSalvo(state, 0, destroyer.uid, { x: 2, y: 2 }, 'H');
    expect(salvo).not.toBeNull();
    expect(salvo!.some((r) => r.hit)).toBe(true);

    // Destroyer has 2 guns; centered-fit H salvo at (2,2) hits (2,2) and (3,2),
    // which covers the scout's 2 segments => sunk.
    expect(scout.sunk).toBe(true);
    expect(p1.destroyedEnemyShipUids).toContain(scout.uid);
    expect(shipAt(p2, { x: 2, y: 2 })).toBeUndefined();
  });

  it('rejects movement for sunk ships including skip orders', () => {
    const state = createInitialState('2p');
    const p1 = state.players[0];
    const p2 = state.players[1];
    const cruiser = p1.ships.find((s) => s.typeId === 'cruiser')!;
    const scout = p2.ships.find((s) => s.typeId === 'scout')!;

    placeShip(p1, cruiser.uid, { x: 0, y: 0 }, 'H');
    placeShip(p2, scout.uid, { x: 2, y: 2 }, 'H');
    resolveSalvo(state, 0, cruiser.uid, { x: 2, y: 2 }, 'H');
    resetFiringRound(state);
    resolveSalvo(state, 0, cruiser.uid, { x: 2, y: 2 }, 'H');

    expect(scout.sunk).toBe(true);
    expect(canMoveShip(state, 1, { shipUid: scout.uid, to: { x: 2, y: 2 }, orientation: 'H', skip: true })).toBe(false);
    expect(canMoveShip(state, 1, { shipUid: scout.uid, to: { x: 3, y: 2 }, orientation: 'H' })).toBe(false);
  });

  it('enforces one shot per ship per firing round', () => {
    const state = createInitialState('2p');
    const p1 = state.players[0];
    const p2 = state.players[1];
    const cruiser = p1.ships.find((s) => s.typeId === 'cruiser')!;
    const scout = p2.ships.find((s) => s.typeId === 'scout')!;

    placeShip(p1, cruiser.uid, { x: 0, y: 0 }, 'H');
    placeShip(p2, scout.uid, { x: 2, y: 2 }, 'H');

    expect(canShipFire(state, 0, cruiser.uid)).toBe(true);
    expect(resolveSalvo(state, 0, cruiser.uid, { x: 2, y: 2 }, 'H')?.some((r) => r.hit)).toBe(true);
    expect(canShipFire(state, 0, cruiser.uid)).toBe(false);
    expect(resolveSalvo(state, 0, cruiser.uid, { x: 2, y: 2 }, 'H')).toBeNull();

    resetFiringRound(state);
    expect(canShipFire(state, 0, cruiser.uid)).toBe(true);
    expect(resolveSalvo(state, 0, cruiser.uid, { x: 2, y: 2 }, 'H')).not.toBeNull();
  });

  it('chooses next firing player based on remaining unfired ships', () => {
    const state = createInitialState('2p');
    const p1 = state.players[0];
    const p2 = state.players[1];
    const p1Scout = p1.ships.find((s) => s.typeId === 'scout')!;
    const p2Scout = p2.ships.find((s) => s.typeId === 'scout')!;

    placeShip(p1, p1Scout.uid, { x: 0, y: 0 }, 'H');
    placeShip(p2, p2Scout.uid, { x: 4, y: 0 }, 'H');

    expect(hasUnfiredShips(state, 0)).toBe(true);
    expect(hasUnfiredShips(state, 1)).toBe(true);
    expect(nextFiringPlayer(state, 0)).toBe(1);

    resolveSalvo(state, 1, p2Scout.uid, { x: 0, y: 0 }, 'H');
    expect(nextFiringPlayer(state, 0)).toBe(0);

    resolveSalvo(state, 0, p1Scout.uid, { x: 4, y: 0 }, 'H');
    expect(hasUnfiredShips(state, 0)).toBe(false);
    expect(hasUnfiredShips(state, 1)).toBe(false);
    expect(nextFiringPlayer(state, 0)).toBeNull();
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
