/** Human-friendly relative time, e.g. "just now", "5m ago", "3d ago". Pure. */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  const delta = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (delta < 60) return "just now";
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(delta / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(delta / 86400);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
