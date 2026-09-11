import type { RelayState } from "./types";

const TWITCH_CONNECTION_WATCHDOG_MS = 60_000;

export function nextRelayAlarm(state: RelayState): number | null {
  const candidates: Array<string | null | undefined> = [
    state.twitch.flushAt,
    state.twitch.reconnectAt,
  ];
  if (state.twitch.enabled) {
    candidates.push(new Date(Date.now() + TWITCH_CONNECTION_WATCHDOG_MS).toISOString());
  }
  if (state.enabled || state.lastError?.startsWith("R2:")) {
    candidates.push(state.nextActionAt);
  }
  const times = candidates
    .filter((value): value is string => typeof value === "string")
    .map(Date.parse)
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}
