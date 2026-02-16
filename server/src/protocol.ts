import { z } from 'zod';

export const ClientHelloSchema = z.object({
  sessionId: z.string().min(3).max(80),
  name: z.string().min(1).max(40),
});

export const CreateRoomSchema = z.object({
  title: z.string().min(1).max(60).optional(),
});

export const JoinRoomSchema = z.object({
  code: z.string().min(4).max(12),
  role: z.enum(['player', 'spectator']).optional(),
});

export const ChatSendSchema = z.object({
  code: z.string().min(4).max(12),
  text: z.string().min(1).max(400),
});

export type ClientHello = z.infer<typeof ClientHelloSchema>;
export type CreateRoom = z.infer<typeof CreateRoomSchema>;
export type JoinRoom = z.infer<typeof JoinRoomSchema>;
export type ChatSend = z.infer<typeof ChatSendSchema>;
