import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { RoomStore, type ClientIdentity, type Role } from './rooms.js';
import { ChatSendSchema, ClientHelloSchema, CreateRoomSchema, JoinRoomSchema } from './protocol.js';

const PORT = Number(process.env.PORT ?? 8080);
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: CORS_ORIGIN.length ? CORS_ORIGIN : true,
    credentials: true,
  })
);

const store = new RoomStore(1000 * 60 * 60); // 1h idle TTL
setInterval(() => store.cleanup(), 60_000).unref();

app.get('/health', (_req, res) => {
  res.json({ ok: true, now: Date.now() });
});

app.get('/rooms', (_req, res) => {
  res.json({ rooms: store.listPublic() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN.length ? CORS_ORIGIN : true,
    credentials: true,
  },
});

type SocketSession = {
  ident: ClientIdentity;
  role: Role;
  seat: 'p1' | 'p2' | 'spectator';
  roomCode: string | null;
};

function safeParse<T>(schema: z.ZodTypeAny, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) {
    throw new Error(r.error.issues.map((i) => i.message).join(', '));
  }
  return r.data as T;
}

function emitRoomState(code: string): void {
  const room = store.get(code);
  if (!room) {
    return;
  }
  io.to(code).emit('room_state', { room });
}

io.on('connection', (socket) => {
  const session: SocketSession = {
    ident: { sessionId: '', name: 'Player' },
    role: 'spectator',
    seat: 'spectator',
    roomCode: null,
  };

  socket.on('hello', (payload) => {
    try {
      session.ident = safeParse<z.infer<typeof ClientHelloSchema>>(ClientHelloSchema, payload);
      socket.emit('hello_ok', { sessionId: session.ident.sessionId });
    } catch (e) {
      socket.emit('error_msg', { message: String(e) });
    }
  });

  socket.on('create_room', (payload) => {
    try {
      if (!session.ident.sessionId) {
        throw new Error('Call hello first');
      }
      const data = safeParse<z.infer<typeof CreateRoomSchema>>(CreateRoomSchema, payload);
      const room = store.create(data.title ?? 'Room');
      socket.emit('room_created', { code: room.code });
      // Auto-join as player
      socket.emit('info_msg', { message: `Room ${room.code} created.` });
    } catch (e) {
      socket.emit('error_msg', { message: String(e) });
    }
  });

  socket.on('join_room', (payload) => {
    try {
      if (!session.ident.sessionId) {
        throw new Error('Call hello first');
      }
      const data = safeParse<z.infer<typeof JoinRoomSchema>>(JoinRoomSchema, payload);
      const code = data.code.toUpperCase();
      const room = store.get(code);
      if (!room) {
        throw new Error('Room not found');
      }

      // leave previous
      if (session.roomCode) {
        socket.leave(session.roomCode);
        const prev = store.get(session.roomCode);
        if (prev) {
          store.leave(prev, session.ident.sessionId);
          emitRoomState(prev.code);
        }
      }

      socket.join(code);
      session.roomCode = code;
      const desiredRole = (data.role ?? 'player') as Role;
      const joined = store.join(room, session.ident, desiredRole);
      session.role = joined.role;
      session.seat = joined.seat;

      socket.emit('join_ok', { code, role: session.role, seat: session.seat });
      emitRoomState(code);
    } catch (e) {
      socket.emit('error_msg', { message: String(e) });
    }
  });

  socket.on('leave_room', () => {
    if (!session.roomCode) {
      return;
    }
    const room = store.get(session.roomCode);
    if (room) {
      store.leave(room, session.ident.sessionId);
      emitRoomState(room.code);
    }
    socket.leave(session.roomCode);
    session.roomCode = null;
  });

  socket.on('chat_send', (payload) => {
    try {
      const data = safeParse<z.infer<typeof ChatSendSchema>>(ChatSendSchema, payload);
      const code = data.code.toUpperCase();
      if (!session.roomCode || session.roomCode !== code) {
        throw new Error('Not in that room');
      }
      const room = store.get(code);
      if (!room) {
        throw new Error('Room not found');
      }
      const msg = store.chat(room, session.ident.name, data.text, session.role);
      io.to(code).emit('chat_message', { code, message: msg });
      emitRoomState(code);
    } catch (e) {
      socket.emit('error_msg', { message: String(e) });
    }
  });

  socket.on('disconnect', () => {
    if (!session.roomCode || !session.ident.sessionId) {
      return;
    }
    const room = store.get(session.roomCode);
    if (room) {
      store.leave(room, session.ident.sessionId);
      emitRoomState(room.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  if (CORS_ORIGIN.length) {
    console.log(`[server] cors origins: ${CORS_ORIGIN.join(', ')}`);
  }
});
