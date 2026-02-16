export function getOrCreateSessionId(): string {
  const key = 'mb_session_id';
  const existing = localStorage.getItem(key);
  if (existing && existing.length > 8) {
    return existing;
  }
  const id = crypto.randomUUID ? crypto.randomUUID() : `sess_${Math.random().toString(16).slice(2)}${Date.now()}`;
  localStorage.setItem(key, id);
  return id;
}

export function getOrCreateDisplayName(): string {
  const key = 'mb_display_name';
  const existing = localStorage.getItem(key);
  if (existing && existing.trim()) {
    return existing;
  }
  const name = `Captain ${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem(key, name);
  return name;
}

export function setDisplayName(name: string): void {
  localStorage.setItem('mb_display_name', name);
}
