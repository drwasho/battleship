import type { RoomPublicInfo, RoomState } from './types';

export function formatRoomRow(r: RoomPublicInfo): string {
  const ageMin = Math.max(0, Math.round((Date.now() - r.updatedAt) / 60000));
  return `${r.title} • ${r.code} • ${r.players}/2 players • ${r.spectators} specs • ${ageMin}m ago`;
}

export function rosterText(room: RoomState): string {
  const p1 = room.p1 ? room.p1.name : '(empty)';
  const p2 = room.p2 ? room.p2.name : '(empty)';
  const specs = room.spectators.map((s) => s.name).join(', ') || '(none)';
  return `P1: ${p1}\nP2: ${p2}\nSpectators: ${specs}`;
}
