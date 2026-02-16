import { io, type Socket } from 'socket.io-client';
import type { RoomPublicInfo, Role } from './types';

export interface OnlineClientOpts {
  serverUrl: string;
}

export class OnlineClient {
  // Keep socket typing loose for now; we’ll tighten once protocol stabilizes.
  socket: Socket;

  constructor(opts: OnlineClientOpts) {
    this.socket = io(opts.serverUrl, {
      transports: ['websocket', 'polling'],
    });
  }

  hello(sessionId: string, name: string): void {
    this.socket.emit('hello', { sessionId, name });
  }

  async listRooms(serverUrl: string): Promise<RoomPublicInfo[]> {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/rooms`);
    if (!res.ok) {
      throw new Error(`rooms fetch failed: ${res.status}`);
    }
    const json = (await res.json()) as { rooms: RoomPublicInfo[] };
    return json.rooms;
  }

  createRoom(title?: string): void {
    this.socket.emit('create_room', { title });
  }

  joinRoom(code: string, role?: Role): void {
    this.socket.emit('join_room', { code, role });
  }

  leaveRoom(): void {
    this.socket.emit('leave_room');
  }

  chatSend(code: string, text: string): void {
    this.socket.emit('chat_send', { code, text });
  }

  close(): void {
    this.socket.close();
  }
}
