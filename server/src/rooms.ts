import { randomBytes } from 'node:crypto';

export type Role = 'player' | 'spectator';

export interface ClientIdentity {
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

function code6(): string {
  // Crockford-ish alphanum, uppercase, avoid ambiguous chars
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

function id12(): string {
  return randomBytes(6).toString('hex');
}

export class RoomStore {
  private rooms = new Map<string, RoomState>();

  constructor(private ttlMs = 1000 * 60 * 60) {}

  listPublic(): RoomPublicInfo[] {
    const list: RoomPublicInfo[] = [];
    for (const r of this.rooms.values()) {
      list.push({
        code: r.code,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        inProgress: r.inProgress,
        players: (r.p1 ? 1 : 0) + (r.p2 ? 1 : 0),
        spectators: r.spectators.length,
      });
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(code: string): RoomState | undefined {
    return this.rooms.get(code);
  }

  create(title: string): RoomState {
    let code = code6();
    while (this.rooms.has(code)) {
      code = code6();
    }
    const now = Date.now();
    const room: RoomState = {
      code,
      title: title.trim() || 'Room',
      createdAt: now,
      updatedAt: now,
      inProgress: false,
      p1: null,
      p2: null,
      spectators: [],
      chat: [],
    };
    this.rooms.set(code, room);
    return room;
  }

  touch(room: RoomState): void {
    room.updatedAt = Date.now();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      if (now - r.updatedAt > this.ttlMs) {
        this.rooms.delete(code);
      }
    }
  }

  join(room: RoomState, ident: ClientIdentity, role: Role): { role: Role; seat: 'p1' | 'p2' | 'spectator' } {
    // Reconnect: if session already seated, keep it.
    if (room.p1?.sessionId === ident.sessionId) {
      room.p1.name = ident.name;
      this.touch(room);
      return { role: 'player', seat: 'p1' };
    }
    if (room.p2?.sessionId === ident.sessionId) {
      room.p2.name = ident.name;
      this.touch(room);
      return { role: 'player', seat: 'p2' };
    }
    const specIdx = room.spectators.findIndex((s) => s.sessionId === ident.sessionId);
    if (specIdx >= 0) {
      room.spectators[specIdx]!.name = ident.name;
      this.touch(room);
      return { role: 'spectator', seat: 'spectator' };
    }

    if (role === 'player') {
      if (!room.p1) {
        room.p1 = { sessionId: ident.sessionId, name: ident.name };
        this.touch(room);
        return { role: 'player', seat: 'p1' };
      }
      if (!room.p2) {
        room.p2 = { sessionId: ident.sessionId, name: ident.name };
        this.touch(room);
        return { role: 'player', seat: 'p2' };
      }
      // fall through to spectator if full
    }

    room.spectators.push({ sessionId: ident.sessionId, name: ident.name });
    this.touch(room);
    return { role: 'spectator', seat: 'spectator' };
  }

  leave(room: RoomState, sessionId: string): void {
    if (room.p1?.sessionId === sessionId) {
      room.p1 = null;
    }
    if (room.p2?.sessionId === sessionId) {
      room.p2 = null;
    }
    room.spectators = room.spectators.filter((s) => s.sessionId !== sessionId);
    this.touch(room);
  }

  chat(room: RoomState, name: string, text: string, role: Role): ChatMessage {
    const msg: ChatMessage = {
      id: id12(),
      ts: Date.now(),
      name,
      text: text.slice(0, 400),
      role,
    };
    room.chat.push(msg);
    if (room.chat.length > 50) {
      room.chat.splice(0, room.chat.length - 50);
    }
    this.touch(room);
    return msg;
  }
}
