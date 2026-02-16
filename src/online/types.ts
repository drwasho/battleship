export type Role = 'player' | 'spectator';

export interface RoomPublicInfo {
  code: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  inProgress: boolean;
  players: number;
  spectators: number;
}

export interface Seat {
  sessionId: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  ts: number;
  name: string;
  text: string;
  role: Role;
}

export interface RoomState {
  code: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  inProgress: boolean;
  p1: Seat | null;
  p2: Seat | null;
  spectators: Seat[];
  chat: ChatMessage[];
}
