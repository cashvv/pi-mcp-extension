/**
 * Idle eviction of unused MCP servers + mcp_disconnect (CAS-523).
 *
 * Pure decision logic is tested directly; the wiring (tool_call / turn
 * counting / stop recipe) is tested through a full extension load against the
 * mock stdio server, the same way tests/management-tools.test.ts does it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/index.js";
import {
  createIdleStopState,
  recordSeen,
  recordTurn,
  recordUse,
  selectIdleServers,
  IDLE_STOP_TURNS,
} from "../src/idle-stop.js";
import { createMockExtension, createMockContext, type MockExtension } from "./helpers/mock-extension.js";

describe("idle-stop decision", () => {
  it("stops after 10 idle turns, keeps on the boundary", () => {
    assert.equal(IDLE_STOP_TURNS, 10);
    const state = createIdleStopState();
    recordUse(state, "github");
    for (let turn = 1; turn <= 10; turn += 1) {
      recordTurn(state);
      assert.deepEqual(selectIdleServers(state, ["github"]), [], `turn ${turn}`);
    }
    recordTurn(state);
    assert.deepEqual(selectIdleServers(state, ["github"]), ["github"]);
  });

  it("use resets the counter, servers are independent", () => {
    const state = createIdleStopState();
    recordSeen(state, ["github", "playwright"]);
    for (let index = 0; index < 5; index += 1) {
      recordTurn(state);
    }
    recordUse(state, "github");
    for (let index = 0; index < 6; index += 1) {
      recordTurn(state);
    }
    assert.deepEqual(selectIdleServers(state, ["github", "playwright"]), ["playwright"]);
  });

  it("first sight counts as use, unknown names are kept verbatim", () => {
    const state = createIdleStopState();
    recordTurn(state);
    recordSeen(state, ["lazy"]);
    recordUse(state, "");
    assert.deepEqual(selectIdleServers(state, ["lazy"]), []);
    for (let index = 0; index < 10; index += 1) {
      recordTurn(state);
    }
    assert.deepEqual(selectIdleServers(state, ["lazy"]), []);
    recordTurn(state);
    assert.deepEqual(selectIdleServers(state, ["lazy"]), ["lazy"]);
  });
});

const mockServer = join(dirname(fileURLToPath(import.meta.url)), "mock-server.ts");
const tsxEsmLoader = import.meta.resolve("tsx/esm");

async function loadWithLazyServer(dir: string) {
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
  await extension(mockExt.api, { bootstrapCwd: dir, globalConfigPath: join(dir, "absent-global.json") });
  await mockExt.events.get("session_start")({}, ctx);
  return { mockExt, ctx };
}

type StatusRow = { name: string; state: string; tools: { discovered: number; active: number } };

async function statusOf(mockExt: MockExtension, ctx: unknown): Promise<StatusRow[]> {
  const raw = await mockExt.tools.get("mcp_status").execute("", {}, undefined, undefined, ctx);
  return JSON.parse(raw.content[0].text) as StatusRow[];
}

async function turns(mockExt: MockExtension, ctx: unknown, count: number): Promise<void> {
  const handler = mockExt.events.get("before_agent_start");
  for (let index = 0; index < count; index += 1) {
    await handler({}, ctx);
  }
}

describe("idle eviction wiring", () => {
  it("stops a server idle for 10 turns and keeps a used one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-idle-"));
    const { mockExt, ctx } = await loadWithLazyServer(dir);
    try {
      assert.ok(mockExt.tools.has("mcp_disconnect"));
      await mockExt.tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx);
      const useTool = mockExt.events.get("tool_call");
      await useTool({ toolName: "mcp_lazy_echo", input: { message: "hi" } }, ctx);
      await turns(mockExt, ctx, 10);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready");
      await turns(mockExt, ctx, 1);
      const after = await statusOf(mockExt, ctx);
      assert.equal(after[0]?.state, "stopped");
      assert.ok((after[0]?.tools.discovered ?? 0) > 0);
      assert.equal(after[0]?.tools.active, 0);
      assert.ok(!mockExt.activeTools.some((name) => name.startsWith("mcp_lazy_")));
    } finally {
      await mockExt.events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("mcp_connect and mcp_read_resource count as use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-idle-use-"));
    const { mockExt, ctx } = await loadWithLazyServer(dir);
    try {
      await mockExt.tools.get("mcp_connect").execute("", { name: "lazy" }, undefined, undefined, ctx);
      const useTool = mockExt.events.get("tool_call");
      await turns(mockExt, ctx, 5);
      await useTool({ toolName: "mcp_connect", input: { name: "lazy" } }, ctx);
      await turns(mockExt, ctx, 10);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready");
      await useTool({ toolName: "mcp_read_resource", input: { server: "lazy", uri: "mock://docs/readme" } }, ctx);
      await turns(mockExt, ctx, 10);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "ready");
      await turns(mockExt, ctx, 1);
      assert.equal((await statusOf(mockExt, ctx))[0]?.state, "stopped");
    } finally {
      await mockExt.events.get("session_shutdown")?.({}, ctx);
      await rm(dir, { recursive: true, force: true });
    }
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
