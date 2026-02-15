import { BOARD_SIZE, GUN_DAMAGE, SHIP_BY_ID, SHIPS } from './data';
import { SeededRng } from './rng';
import type {
  Coord,
  GameState,
  MoveOrder,
  MoveResolveResult,
  PlayerId,
  PlayerState,
  ShipInstance,
  ShipTypeId,
  ShotResult,
} from './types';

export function key(c: Coord): string {
  return `${c.x},${c.y}`;
}

export function cloneCoord(c: Coord): Coord {
  return { x: c.x, y: c.y };
}

export function inBounds(c: Coord): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < BOARD_SIZE && c.y < BOARD_SIZE;
}

export function shipCells(ship: ShipInstance): Coord[] {
  const size = SHIP_BY_ID[ship.typeId].size;
  const cells: Coord[] = [];
  for (let i = 0; i < size; i += 1) {
    cells.push({
      x: ship.anchor.x + (ship.orientation === 'H' ? i : 0),
      y: ship.anchor.y + (ship.orientation === 'V' ? i : 0),
    });
  }
  return cells;
}

function occupyMap(players: PlayerState[], ignoreUid?: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of players) {
    for (const s of p.ships) {
      if (!s.placed || s.sunk || s.uid === ignoreUid) {
        continue;
      }
      for (const c of shipCells(s)) {
        map.set(key(c), s.uid);
      }
    }
  }
  return map;
}

export function canPlaceShip(player: PlayerState, ship: ShipInstance, anchor: Coord, orientation: ShipInstance['orientation']): boolean {
  const copy: ShipInstance = { ...ship, anchor: cloneCoord(anchor), orientation };
  const ownPlaced = player.ships.filter((s) => s.uid !== ship.uid && s.placed && !s.sunk);
  const occ = new Set<string>();
  for (const s of ownPlaced) {
    for (const c of shipCells(s)) {
      occ.add(key(c));
    }
  }
  for (const c of shipCells(copy)) {
    if (!inBounds(c) || occ.has(key(c))) {
      return false;
    }
  }
  return true;
}

export function placeShip(player: PlayerState, shipUid: string, anchor: Coord, orientation: ShipInstance['orientation']): boolean {
  const ship = player.ships.find((s) => s.uid === shipUid);
  if (!ship || ship.sunk) {
    return false;
  }
  if (!canPlaceShip(player, ship, anchor, orientation)) {
    return false;
  }
  ship.anchor = cloneCoord(anchor);
  ship.orientation = orientation;
  ship.placed = true;
  return true;
}

export function allShipsPlaced(player: PlayerState): boolean {
  return player.ships.every((s) => s.placed);
}

export function shipAt(player: PlayerState, target: Coord): ShipInstance | undefined {
  return player.ships.find((s) => s.placed && !s.sunk && shipCells(s).some((c) => c.x === target.x && c.y === target.y));
}

export function shipDamage(ship: ShipInstance): number {
  const template = SHIP_BY_ID[ship.typeId];
  const total = template.guns.reduce((acc, g) => acc + g.count * GUN_DAMAGE[g.type], 0);
  return total;
}

function addEphemeralImpactMarker(
  player: PlayerState,
  marker: { board: 'own' | 'target'; shipUid: string; target: Coord }
): void {
  const exists = player.ephemeralImpactMarkers.some(
    (m) => m.board === marker.board && m.shipUid === marker.shipUid && m.target.x === marker.target.x && m.target.y === marker.target.y
  );
  if (!exists) {
    player.ephemeralImpactMarkers.push(marker);
  }
}

export function resolveShot(state: GameState, attackerId: PlayerId, shipUid: string, target: Coord): ShotResult | null {
  const defenderId = attackerId === 0 ? 1 : 0;
  const attacker = state.players[attackerId];
  const defender = state.players[defenderId];
  const ship = attacker.ships.find((s) => s.uid === shipUid && !s.sunk && s.placed);
  if (!ship || !inBounds(target) || state.firedThisRound[attackerId].has(shipUid)) {
    return null;
  }

  const hitShip = shipAt(defender, target);
  const damage = shipDamage(ship);
  const result: ShotResult = {
    attacker: attackerId,
    defender: defenderId,
    shipUid,
    target: cloneCoord(target),
    hit: Boolean(hitShip),
    damage,
  };

  if (hitShip) {
    result.hitShipUid = hitShip.uid;
    hitShip.hp = Math.max(0, hitShip.hp - damage);
    if (hitShip.hp === 0) {
      hitShip.sunk = true;
      result.sunkShipUid = hitShip.uid;
      attacker.destroyedEnemyTypes.push(hitShip.typeId);
      if (!attacker.destroyedEnemyShipUids.includes(hitShip.uid)) {
        attacker.destroyedEnemyShipUids.push(hitShip.uid);
      }
    }
    // Note: ephemeral visuals (hit markers / smoke) are applied by the UI layer on impact,
    // so they appear only after shells land.
  } else {
    // Note: miss markers are applied by the UI layer on impact (after the splash).
  }

  state.shotLog.push(result);
  state.firedThisRound[attackerId].add(shipUid);
  return result;
}

export function resetFiringRound(state: GameState): void {
  state.firedThisRound[0].clear();
  state.firedThisRound[1].clear();
}

export function canShipFire(state: GameState, playerId: PlayerId, shipUid: string): boolean {
  const ship = state.players[playerId].ships.find((s) => s.uid === shipUid);
  if (!ship || ship.sunk || !ship.placed) {
    return false;
  }
  return !state.firedThisRound[playerId].has(shipUid);
}

export function hasUnfiredShips(state: GameState, playerId: PlayerId): boolean {
  return state.players[playerId].ships.some((s) => canShipFire(state, playerId, s.uid));
}

export function nextFiringPlayer(state: GameState, current: PlayerId): PlayerId | null {
  const other = current === 0 ? 1 : 0;
  if (hasUnfiredShips(state, other)) {
    return other;
  }
  if (hasUnfiredShips(state, current)) {
    return current;
  }
  return null;
}

function shipMoveRange(ship: ShipInstance): number {
  return SHIP_BY_ID[ship.typeId].move;
}

function manhattan(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function translateShip(ship: ShipInstance, to: Coord): ShipInstance {
  return { ...ship, anchor: cloneCoord(to) };
}

export function canMoveShip(state: GameState, playerId: PlayerId, order: MoveOrder): boolean {
  const player = state.players[playerId];
  const ship = player.ships.find((s) => s.uid === order.shipUid && s.placed && !s.sunk);
  if (!ship) {
    return false;
  }
  if (order.skip) {
    return true;
  }
  if (manhattan(ship.anchor, order.to) > shipMoveRange(ship)) {
    return false;
  }

  const occ = occupyMap(state.players, ship.uid);
  let cursor = cloneCoord(ship.anchor);
  while (cursor.x !== order.to.x) {
    cursor = { ...cursor, x: cursor.x + Math.sign(order.to.x - cursor.x) };
    for (const c of shipCells({ ...ship, anchor: cursor })) {
      if (!inBounds(c) || occ.has(key(c))) {
        return false;
      }
    }
  }
  while (cursor.y !== order.to.y) {
    cursor = { ...cursor, y: cursor.y + Math.sign(order.to.y - cursor.y) };
    for (const c of shipCells({ ...ship, anchor: cursor })) {
      if (!inBounds(c) || occ.has(key(c))) {
        return false;
      }
    }
  }

  const finalShip = translateShip({ ...ship, orientation: order.orientation }, order.to);
  for (const c of shipCells(finalShip)) {
    if (!inBounds(c) || occ.has(key(c))) {
      return false;
    }
  }
  return true;
}

export function resolveMovement(state: GameState, p1Orders: MoveOrder[], p2Orders: MoveOrder[]): MoveResolveResult {
  const all = [...p1Orders, ...p2Orders];
  const applied: string[] = [];
  const rejected: string[] = [];

  const proposals = new Map<string, ShipInstance>();
  for (const order of all) {
    const pid = order.shipUid.startsWith('0-') ? 0 : 1;
    const player = state.players[pid as PlayerId];
    const ship = player.ships.find((s) => s.uid === order.shipUid);
    if (!ship || ship.sunk || !ship.placed) {
      rejected.push(order.shipUid);
      continue;
    }
    if (order.skip) {
      proposals.set(ship.uid, ship);
      applied.push(ship.uid);
      continue;
    }
    if (!canMoveShip(state, pid as PlayerId, order)) {
      rejected.push(ship.uid);
      continue;
    }
    proposals.set(ship.uid, { ...ship, anchor: cloneCoord(order.to), orientation: order.orientation });
    applied.push(ship.uid);
  }

  const endOcc = new Map<string, string>();
  for (const player of state.players) {
    for (const ship of player.ships) {
      if (!ship.placed || ship.sunk) {
        continue;
      }
      const proposal = proposals.get(ship.uid) ?? ship;
      for (const c of shipCells(proposal)) {
        const k = key(c);
        const existing = endOcc.get(k);
        if (existing && existing !== proposal.uid) {
          if (!rejected.includes(existing)) {
            rejected.push(existing);
          }
          if (!rejected.includes(proposal.uid)) {
            rejected.push(proposal.uid);
          }
        } else {
          endOcc.set(k, proposal.uid);
        }
      }
    }
  }

  for (const player of state.players) {
    for (const ship of player.ships) {
      if (rejected.includes(ship.uid)) {
        continue;
      }
      const proposal = proposals.get(ship.uid);
      if (!proposal || proposal === ship) {
        continue;
      }
      ship.anchor = cloneCoord(proposal.anchor);
      ship.orientation = proposal.orientation;
    }
  }

  return { applied: [...new Set(applied)], rejected: [...new Set(rejected)] };
}

export function clearEphemeral(state: GameState): void {
  state.players[0].ephemeralHits.clear();
  state.players[1].ephemeralHits.clear();
  state.players[0].ephemeralImpactMarkers.length = 0;
  state.players[1].ephemeralImpactMarkers.length = 0;
}

export function hasWinner(state: GameState): PlayerId | undefined {
  const alive0 = state.players[0].ships.some((s) => !s.sunk);
  const alive1 = state.players[1].ships.some((s) => !s.sunk);
  if (!alive0 && alive1) {
    return 1;
  }
  if (!alive1 && alive0) {
    return 0;
  }
  return undefined;
}

export function randomFleetPlacement(player: PlayerState, rng: SeededRng): void {
  for (const t of SHIPS) {
    const ship = player.ships.find((s) => s.typeId === t.id)!;
    let placed = false;
    let guard = 0;
    while (!placed && guard < 500) {
      guard += 1;
      const orientation = rng.next() > 0.5 ? 'H' : 'V';
      const x = rng.int(BOARD_SIZE);
      const y = rng.int(BOARD_SIZE);
      placed = placeShip(player, ship.uid, { x, y }, orientation);
    }
  }
}

export function randomLegalShot(state: GameState, attackerId: PlayerId, rng: SeededRng): { shipUid: string; target: Coord } | null {
  const attacker = state.players[attackerId];
  const liveShips = attacker.ships.filter((s) => canShipFire(state, attackerId, s.uid));
  if (!liveShips.length) {
    return null;
  }
  const ship = rng.pick(liveShips);
  let target = { x: rng.int(BOARD_SIZE), y: rng.int(BOARD_SIZE) };
  let guard = 0;
  while (attacker.misses.has(key(target)) && guard < 100) {
    target = { x: rng.int(BOARD_SIZE), y: rng.int(BOARD_SIZE) };
    guard += 1;
  }
  return { shipUid: ship.uid, target };
}

export function randomMovePlan(state: GameState, playerId: PlayerId, rng: SeededRng): MoveOrder[] {
  const player = state.players[playerId];
  const orders: MoveOrder[] = [];
  for (const ship of player.ships) {
    if (ship.sunk || !ship.placed) {
      continue;
    }

    const range = shipMoveRange(ship);
    const candidates: MoveOrder[] = [{ shipUid: ship.uid, to: cloneCoord(ship.anchor), orientation: ship.orientation, skip: true }];
    for (let dx = -range; dx <= range; dx += 1) {
      for (let dy = -range; dy <= range; dy += 1) {
        if (Math.abs(dx) + Math.abs(dy) > range) {
          continue;
        }
        for (const orientation of ['H', 'V'] as const) {
          candidates.push({
            shipUid: ship.uid,
            to: { x: ship.anchor.x + dx, y: ship.anchor.y + dy },
            orientation,
          });
        }
      }
    }
    const legal = candidates.filter((c) => canMoveShip(state, playerId, c));
    orders.push(rng.pick(legal));
  }
  return orders;
}
