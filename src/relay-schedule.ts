import type { RelayState } from "./types";

export function nextRelayAlarm(state: RelayState): number | null {
  const candidates = [state.twitch.flushAt];
  if (state.enabled || state.lastError?.startsWith("R2:")) candidates.push(state.nextActionAt);
  const times = candidates.filter((value): value is string => value !== null)
    .map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}
