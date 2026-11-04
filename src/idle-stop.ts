/**
 * Idle eviction of MCP servers: pure turn/use tracking and the stop decision.
 *
 * A connected server costs context on every request (its tool definitions) and,
 * for stdio servers, a live process tree. When the model stops using a server,
 * neither should linger: after {@link IDLE_STOP_TURNS} turns without a single
 * use, the wiring in `src/index.ts` stops the server through the same recipe as
 * `/mcp:stop` (`cancelServer` + `deactivateServer` + `manager.stopServer`), so
 * the state machine marks the stop deliberate — no `_recover()` respawn — and
 * the tools unload from every session at once.
 *
 * Rules:
 * - a turn is one `before_agent_start` in any session (the manager is global,
 *   so turns and usage are global too: idle means idle everywhere);
 * - a use is any `tool_call` of the server's tools, `mcp_connect` (its `name`
 *   input), or `mcp_read_resource` (its `server` input);
 * - servers whose tools appear without a recorded use count as used at first
 *   sight (eager starts and `/mcp:start` never pass through `mcp_connect`);
 * - only `ready` servers are stopped; `starting`/`stopped` are left alone.
 */
export const IDLE_STOP_TURNS = 10;

export interface IdleStopState {
  turn: number;
  lastUsed: Map<string, number>;
}

export function createIdleStopState(): IdleStopState {
  return { turn: 0, lastUsed: new Map() };
}

export function recordTurn(state: IdleStopState): void {
  state.turn += 1;
}

export function recordUse(state: IdleStopState, server: string): void {
  if (server.length > 0) {
    state.lastUsed.set(server, state.turn);
  }
}

export function recordSeen(state: IdleStopState, servers: readonly string[]): void {
  for (const server of servers) {
    if (!state.lastUsed.has(server)) {
      state.lastUsed.set(server, state.turn);
    }
  }
}

export function selectIdleServers(
  state: IdleStopState,
  readyServers: readonly string[],
): string[] {
  return readyServers.filter(
    (server) => state.turn - (state.lastUsed.get(server) ?? state.turn) > IDLE_STOP_TURNS,
  );
}
