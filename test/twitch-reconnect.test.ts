import { afterEach, describe, expect, it, vi } from "vitest";
import { nextRelayAlarm } from "../src/relay-schedule";
import {
  createTwitchState,
  shouldAttemptTwitchReconnect,
} from "../src/twitch";
import { createStoppedState } from "../src/types";

const time = "2026-09-10T00:00:00.000Z";
const now = Date.parse(time);

afterEach(() => {
  vi.useRealTimers();
});

describe("Twitch IRC reconnect deadline", () => {
  it("does not reconnect before the persisted backoff deadline", () => {
    const state = createTwitchState();
    state.enabled = true;
    state.reconnectAt = new Date(now + 5_000).toISOString();

    expect(shouldAttemptTwitchReconnect(state, now)).toBe(false);
    expect(shouldAttemptTwitchReconnect(state, now + 4_999)).toBe(false);
    expect(shouldAttemptTwitchReconnect(state, now + 5_000)).toBe(true);
  });

  it("keeps reconnectAt ahead of the generic watchdog in the single DO alarm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    const state = createStoppedState(time);
    state.twitch.enabled = true;
    state.twitch.reconnectAt = new Date(now + 1_000).toISOString();

    expect(nextRelayAlarm(state)).toBe(now + 1_000);

    state.twitch.reconnectAt = null;
    expect(nextRelayAlarm(state)).toBe(now + 60_000);
  });

  it("treats legacy state without reconnectAt as immediately eligible", () => {
    const state = createTwitchState();
    delete state.reconnectAt;
    expect(shouldAttemptTwitchReconnect(state, now)).toBe(true);
  });
});
