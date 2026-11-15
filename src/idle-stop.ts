/**
 * Idle eviction of MCP servers: pure thread-activity tracking and the stop decision.
 *
 * A connected server costs context on every request (its tool definitions) and,
 * for stdio servers, a live process tree. But removing tools in the middle of
 * work changes the request prefix and invalidates the provider's prompt cache,
 * so the next request goes out uncached. Servers are therefore never stopped
 * while the thread is being worked on, however long one of them goes unused.
 * Only when a prompt arrives after more than {@link IDLE_STOP_MS} without any
 * activity in the session — by then the prompt cache has expired anyway — does
 * the wiring in `src/index.ts` stop every ready server through the same recipe
 * as `/mcp:stop` (`cancelServer` + `deactivateServer` + `manager.stopServer`),
 * so the state machine marks the stop deliberate — no `_recover()` respawn.
 *
 * pi loads extensions per session runtime (`moduleCache: false`), so each
 * session has its own manager, server processes and idle state.
 *
 * Rules:
 * - activity is any `before_agent_start`, `turn_start`, `turn_end`, `agent_end`
 *   or `tool_call` of this session; the wiring passes the time of each one;
 * - the decision is taken only on `before_agent_start` (a user prompt), before
 *   that prompt is recorded as activity;
 * - a session with no recorded activity (brand new) is never idle;
 * - exactly {@link IDLE_STOP_MS} of silence is not idle yet, more is.
 *
 * The clock is injected by the caller: nothing here reads the time itself.
 */
export const IDLE_STOP_MS = 60 * 60 * 1000;

export interface IdleStopState {
  /** Time (ms) of the last activity in the session; `null` until the first one. */
  lastActivityAt: number | null;
}

export function createIdleStopState(): IdleStopState {
  return { lastActivityAt: null };
}

export function recordActivity(state: IdleStopState, now: number): void {
  state.lastActivityAt = now;
}

/** True when the session had activity before and more than {@link IDLE_STOP_MS} passed since the last one. */
export function isThreadIdle(state: IdleStopState, now: number): boolean {
  return state.lastActivityAt !== null && now - state.lastActivityAt > IDLE_STOP_MS;
}
