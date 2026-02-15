import { SHIPS } from './data';
import type { GameState, PlayerId, PlayerState, ShipInstance } from './types';

function makeShips(owner: PlayerId): ShipInstance[] {
  return SHIPS.map((t) => ({
    uid: `${owner}-${t.id}`,
    typeId: t.id,
    owner,
    anchor: { x: 0, y: 0 },
    orientation: 'H',
    hp: t.maxHp,
    placed: false,
    sunk: false,
  }));
}

export function createPlayer(id: PlayerId, name: string, isAI: boolean): PlayerState {
  return {
    id,
    name,
    isAI,
    ships: makeShips(id),
    misses: new Set<string>(),
    ephemeralHits: new Set<string>(),
    destroyedEnemyTypes: [],
  };
}

export function createInitialState(mode: '1p' | '2p'): GameState {
  const p1 = createPlayer(0, 'Player 1', false);
  const p2 = createPlayer(1, mode === '1p' ? 'Easy AI' : 'Player 2', mode === '1p');
  return {
    mode,
    phase: 'placement_p1',
    round: 1,
    players: [p1, p2],
    shotLog: [],
  };
}
