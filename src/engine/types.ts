export type PlayerId = 0 | 1;

export type GunType = 'light' | 'medium' | 'heavy';

export type Orientation = 'H' | 'V';

export type ShipTypeId =
  | 'scout'
  | 'destroyer'
  | 'cruiser'
  | 'battleship'
  | 'dreadnought';

export interface Coord {
  x: number;
  y: number;
}

export interface GunSpec {
  type: GunType;
  count: number;
}

export interface ShipTemplate {
  id: ShipTypeId;
  name: string;
  size: number;
  maxHp: number;
  move: number;
  guns: GunSpec[];
}

export interface ShipInstance {
  uid: string;
  typeId: ShipTypeId;
  owner: PlayerId;
  anchor: Coord;
  orientation: Orientation;
  hp: number;
  placed: boolean;
  sunk: boolean;
}

export interface ShotResult {
  attacker: PlayerId;
  defender: PlayerId;
  shipUid: string;
  target: Coord;
  hit: boolean;
  damage: number;
  hitShipUid?: string;
  sunkShipUid?: string;
}

export interface EphemeralImpactMarker {
  board: 'own' | 'target';
  shipUid: string;
  target: Coord;
}

export interface MoveOrder {
  shipUid: string;
  to: Coord;
  orientation: Orientation;
  skip?: boolean;
}

export interface MoveResolveResult {
  applied: string[];
  rejected: string[];
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  isAI: boolean;
  ships: ShipInstance[];
  misses: Set<string>;
  ephemeralHits: Set<string>;
  ephemeralImpactMarkers: EphemeralImpactMarker[];
  destroyedEnemyTypes: ShipTypeId[];
  destroyedEnemyShipUids: string[];
}

export type Phase =
  | 'menu'
  | 'placement_p1'
  | 'placement_p2'
  | 'firing_p1'
  | 'firing_p2'
  | 'movement_p1'
  | 'movement_p2'
  | 'game_over';

export interface GameState {
  mode: '1p' | '2p';
  phase: Phase;
  round: number;
  players: [PlayerState, PlayerState];
  firedThisRound: [Set<string>, Set<string>];
  shotLog: ShotResult[];
  winner?: PlayerId;
}
