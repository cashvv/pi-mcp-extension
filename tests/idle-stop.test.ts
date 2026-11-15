/**
 * Idle eviction of MCP servers after a long silence in the thread (CAS-1618,
 * replaces the per-server turn counting of CAS-523) + mcp_disconnect.
 *
 * Pure decision logic is tested directly; the wiring (activity events / stop
 * recipe) is tested through a full extension load against the mock stdio
 * server with an injected clock, the same way tests/management-tools.test.ts
 * loads the extension.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/index.js";
import { createIdleStopState, isThreadIdle, recordActivity, IDLE_STOP_MS } from "../src/idle-stop.js";
import { createMockExtension, createMockContext, type MockExtension } from "./helpers/mock-extension.js";

describe("idle-stop decision", () => {
  it("is one hour", () => {
    assert.equal(IDLE_STOP_MS, 60 * 60 * 1000);
  });

  it("a brand-new session is never idle", () => {
    const state = createIdleStopState();
    assert.equal(isThreadIdle(state, 0), false);
    assert.equal(isThreadIdle(state, 100 * IDLE_STOP_MS), false);
  });

  it("is idle only after more than an hour since the last activity", () => {
    const state = createIdleStopState();
    recordActivity(state, 1_000);
    assert.equal(isThreadIdle(state, 1_000), false);
    assert.equal(isThreadIdle(state, 1_000 + IDLE_STOP_MS - 1), false);
    assert.equal(isThreadIdle(state, 1_000 + IDLE_STOP_MS), false, "boundary");
    assert.equal(isThreadIdle(state, 1_000 + IDLE_STOP_MS + 1), true);
  });

  it("any later activity restarts the hour", () => {
    const state = createIdleStopState();
    recordActivity(state, 0);
    recordActivity(state, IDLE_STOP_MS);
    assert.equal(isThreadIdle(state, 2 * IDLE_STOP_MS), false);
    assert.equal(isThreadIdle(state, 2 * IDLE_STOP_MS + 1), true);
  });
});

const mockServer = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
const tsxEsmLoader = import.meta.resolve("tsx/esm");

interface Clock {
  now: number;
}

async function loadWithLazyServer(dir: string, clock: Clock = { now: 1_700_000_000_000 }) {
  const mockExt = createMockExtension();
  const ctx = createMockContext({ cwd: dir, hasUI: false });
  await mkdir(join(dir, ".pi"));
  await writeFile(
    join(dir, ".pi", "mcp.json"),
    JSON.stringify({
      settings: { maxRetries: 0 },
      mcpServers: { lazy: { command: "node", args: ["--import", tsxEsmLoader, mockServer], lifecycle: "lazy" } },
    }),
  );
  await extension(mockExt.api, {
    bootstrapCwd: dir,
    globalConfigPath: join(dir, "absent-global.json"),
    now: () => clock.now,
  });
  await mockExt.events.get("session_start")({}, ctx);
  return { mockExt, ctx, clock };
}

type StatusRow = { name: string; state: string; tools: { discovered: number; active: number } };

async function statusOf(mockExt: MockExtension, ctx: unknown): Promise<StatusRow[]> {
  const raw = await mockExt.tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
  return JSON.parse(raw.content[0].text) as StatusRow[];
}

async function prompt(mockExt: MockExtension, ctx: unknown): Promise<void> {
  await mockExt.events.get("before_agent_start")({}, ctx);
}

async function connectLazy(mockExt: MockExtension, ctx: unknown): Promise<void> {
  await mockExt.tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx);
}

async function withLazyServer(
  prefix: string,
  run: (loaded: Awaited<ReturnType<typeof loadWithLazyServer>>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const loaded = await loadWithLazyServer(dir);
  try {
    await run(loaded);
  } finally {
    await loaded.mockExt.events.get("session_shutdown")?.({}, loaded.ctx);
    await rm(dir, { recursive: true, force: true });
  }
}

describe("idle eviction wiring", () => {
  it("never stops an unused server while the thread is active, however many turns pass", async () => {
    await withLazyServer("pi-mcp-idle-active-", async ({ mockExt, ctx, clock }) => {
      assert.ok(mockExt.tools.has("mcp_disconnect"));
      await connectLazy(mockExt, ctx);
      // 30 prompts, 59 minutes apart, none of them using the server: far more
      // than the old 10-turn limit and 29 hours of wall time, but never a full
      // hour of silence.
      for (let turn = 0; turn < 30; turn += 1) {
        await prompt(mockExt, ctx);
        clock.now += IDLE_STOP_MS - 60_000;
      }
      const row = (await statusOf(mockExt, ctx))[0];
      assert.equal(row?.state, "ready");
      assert.ok((row?.tools.active ?? 0) > 0);
    });
  });

  it("stops all ready servers on the first prompt after more than an hour of silence", async () => {
    await withLazyServer("pi-mcp-idle-stale-", async ({ mockExt, ctx, clock }) => {
      await connectLazy(mockExt, ctx);
      await prompt(mockExt, ctx);
      clock.now += IDLE_STOP_MS;
      await prompt(mockExt, ctx);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready", "exactly one hour is not idle");
      clock.now += IDLE_STOP_MS + 1;
      await prompt(mockExt, ctx);
      const after = await statusOf(mockExt, ctx);
      assert.equal(after[0]?.state, "stopped");
      assert.ok((after[0]?.tools.discovered ?? 0) > 0);
      assert.equal(after[0]?.tools.active, 0);
      assert.ok(!mockExt.activeTools.some((name) => name.startsWith("mcp_lazy_")));
    });
  });

  it("a brand-new session stops nothing on its first prompt", async () => {
    await withLazyServer("pi-mcp-idle-new-", async ({ mockExt, ctx, clock }) => {
      // like /mcp:start before the first prompt: no activity event recorded yet
      await connectLazy(mockExt, ctx);
      clock.now += 5 * IDLE_STOP_MS;
      await prompt(mockExt, ctx);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready");
    });
  });

  for (const event of ["turn_start", "turn_end", "agent_end", "tool_call"]) {
    it(`${event} counts as activity`, async () => {
      await withLazyServer("pi-mcp-idle-activity-", async ({ mockExt, ctx, clock }) => {
        await connectLazy(mockExt, ctx);
        await prompt(mockExt, ctx);
        // a long agent run: the last event comes 50 minutes after the prompt
        clock.now += 50 * 60_000;
        await mockExt.events.get(event)({ toolName: "bash", input: {} }, ctx);
        clock.now += 50 * 60_000;
        await prompt(mockExt, ctx);
        assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready");
      });
    });
  }

  it("a server reconnected after an idle stop stays while the thread is active", async () => {
    await withLazyServer("pi-mcp-idle-restart-", async ({ mockExt, ctx, clock }) => {
      await connectLazy(mockExt, ctx);
      await prompt(mockExt, ctx);
      clock.now += IDLE_STOP_MS + 1;
      await prompt(mockExt, ctx);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "stopped");
      await connectLazy(mockExt, ctx);
      for (let turn = 0; turn < 12; turn += 1) {
        clock.now += 60_000;
        await prompt(mockExt, ctx);
      }
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready");
    });
  });
});

describe("mcp_disconnect", () => {
  it("disconnects a ready server, rejects unknown names, reconnects cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-disconnect-"));
    const { mockExt, ctx } = await loadWithLazyServer(dir);
    try {
      await assert.rejects(
        mockExt.tools.get("mcp_disconnect").execute("", { name: "nope" }, undefined, undefined, ctx),
        /Unknown MCP server name/,
      );
      await mockExt.tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx);
      assert.ok(mockExt.activeTools.some((name) => name.startsWith("mcp_lazy_")));
      const result = await mockExt.tools
        .get("mcp_disconnect")
        .execute("", { name: "lazy" }, undefined, undefined, ctx);
      assert.match(result.content[0].text, /disconnected/);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "stopped");
      assert.ok(!mockExt.activeTools.some((name) => name.startsWith("mcp_lazy_")));
      const again = await mockExt.tools
        .get("mcp_disconnect")
        .execute("", { name: "lazy" }, undefined, undefined, ctx);
      assert.match(again.content[0].text, /disconnected/);
      await mockExt.tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready");
    } finally {
      await mockExt.events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
