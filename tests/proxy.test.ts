import { IncomingMessage } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { AccountPool, parseResetsAtMs } from "../src/accounts/pool.js";
import { AccountStore } from "../src/accounts/store.js";
import { peekSseFallback } from "../src/proxy/forward.js";
import { decodeRequestBody, extractSessionKey } from "../src/proxy/headers.js";
import { attachCodexWebSocket } from "../src/proxy/websocket.js";

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

async function readAll(response: Response): Promise<string> {
  return response.body ? await response.text() : "";
}

describe("decodeRequestBody", () => {
  it("reads plain bodies", () => {
    const body = Buffer.from(JSON.stringify({ prompt_cache_key: "sess-1" }));
    expect(decodeRequestBody(body, undefined)).toContain("sess-1");
  });

  it("decodes gzip so sticky routing still sees the cache key", () => {
    const raw = JSON.stringify({ prompt_cache_key: "sess-gzip" });
    const body = zlib.gzipSync(Buffer.from(raw));
    const decoded = decodeRequestBody(body, "gzip");

    const req = { method: "POST", headers: {} } as IncomingMessage;
    expect(extractSessionKey(req, decoded)).toBe("sess-gzip");
  });

  it("decodes zstd, the encoding Codex uses", () => {
    const raw = JSON.stringify({ conversation_id: "sess-zstd" });
    const body = zlib.zstdCompressSync(Buffer.from(raw));
    const decoded = decodeRequestBody(body, "zstd");

    const req = { method: "POST", headers: {} } as IncomingMessage;
    expect(extractSessionKey(req, decoded)).toBe("sess-zstd");
  });

  it("returns undefined instead of mojibake for undecodable bodies", () => {
    expect(decodeRequestBody(Buffer.from([0x1f, 0x8b, 0x00]), "gzip")).toBeUndefined();
  });
});

describe("peekSseFallback", () => {
  it("surfaces quota errors delivered inside a 200 SSE stream", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 600;
    const frame = `event: response.failed\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "usage_limit_reached", resets_at: resetsAt },
    })}\n\n`;

    const peeked = await peekSseFallback(sseResponse(frame));
    expect(peeked.status).toBe(429);
    expect(peeked.errorText).toContain("usage_limit_reached");

    // The cooldown must come from resets_at, not the 2s first-level backoff.
    const cooldownMs = parseResetsAtMs(peeked.errorText ?? "")! - Date.now();
    expect(cooldownMs).toBeGreaterThan(9 * 60_000);
  });

  it("maps overloaded streams to a retryable 503", async () => {
    const frame = `event: error\ndata: ${JSON.stringify({
      error: { type: "server_is_overloaded" },
    })}\n\n`;

    const peeked = await peekSseFallback(sseResponse(frame));
    expect(peeked.status).toBe(503);
  });

  it("replays buffered bytes for a healthy stream", async () => {
    const body =
      `event: response.created\ndata: {"type":"response.created"}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed"}\n\n`;

    const peeked = await peekSseFallback(sseResponse(body));
    expect(peeked.status).toBeUndefined();
    expect(await readAll(peeked.response)).toBe(body);
  });

  it("leaves non-SSE responses untouched", async () => {
    const json = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const peeked = await peekSseFallback(json);
    expect(peeked.response).toBe(json);
  });
});

interface WsHarness {
  localUrl: string;
  upstreamMessages: string[];
  upstreamConnections: number;
  pool: AccountPool;
  close: () => Promise<void>;
}

interface WsHarnessOptions {
  accountCount?: number;
  capacityRetryDelaysMs?: readonly number[];
  onUpstreamMessage?: (
    socket: WebSocket,
    connectionNumber: number,
    message: string
  ) => void;
}

async function startWsHarness(
  handshakeDelayMs: number,
  options: WsHarnessOptions = {}
): Promise<WsHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zion-pool-ws-"));
  const store = new AccountStore(dataDir);
  for (let index = 0; index < (options.accountCount ?? 1); index++) {
    store.saveAuth(`acct-${index + 1}`, {
      tokens: { access_token: `token-${index + 1}` },
    });
  }
  const pool = new AccountPool(store, 95);

  const upstreamMessages: string[] = [];
  let upstreamConnections = 0;

  const upstream = new WebSocketServer({
    port: 0,
    verifyClient: (_info, done) => {
      setTimeout(() => done(true), handshakeDelayMs);
    },
  });
  upstream.on("connection", (socket) => {
    upstreamConnections += 1;
    const connectionNumber = upstreamConnections;
    socket.on("message", (data) => {
      const message = data.toString();
      upstreamMessages.push(message);
      options.onUpstreamMessage?.(socket, connectionNumber, message);
    });
  });
  await new Promise((resolve) => upstream.once("listening", resolve));

  const local = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => local.once("listening", resolve));

  const upstreamPort = (upstream.address() as AddressInfo).port;
  attachCodexWebSocket(local, {
    pool,
    upstreamBase: "http://127.0.0.1",
    upstreamWsUrl: `ws://127.0.0.1:${upstreamPort}`,
    capacityRetryDelaysMs: options.capacityRetryDelaysMs,
  });

  const localPort = (local.address() as AddressInfo).port;

  return {
    localUrl: `ws://127.0.0.1:${localPort}`,
    upstreamMessages,
    pool,
    get upstreamConnections() {
      return upstreamConnections;
    },
    close: async () => {
      // close() waits on live sockets, so drop them first.
      for (const server of [local, upstream]) {
        for (const socket of server.clients) socket.terminate();
      }
      await new Promise((resolve) => local.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("attachCodexWebSocket", () => {
  let harness: WsHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("flushes frames sent before the upstream handshake completes", async () => {
    harness = await startWsHarness(80);
    const client = new WebSocket(harness.localUrl);
    await new Promise((resolve) => client.once("open", resolve));

    client.send(JSON.stringify({ type: "response.create", id: "first" }));
    client.send(JSON.stringify({ type: "response.create", id: "second" }));

    await new Promise((resolve) => setTimeout(resolve, 400));
    client.close();

    expect(harness.upstreamMessages.map((m) => JSON.parse(m).id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("drops queued frames when the client disconnects before upstream opens", async () => {
    harness = await startWsHarness(250);
    const client = new WebSocket(harness.localUrl);
    await new Promise((resolve) => client.once("open", resolve));

    client.send(JSON.stringify({ type: "response.create", id: "orphan" }));
    client.close();

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(harness.upstreamMessages).toEqual([]);
  });

  it("reconnects and replays the request after a pre-response capacity error", async () => {
    harness = await startWsHarness(0, {
      accountCount: 2,
      capacityRetryDelaysMs: [0],
      onUpstreamMessage: (socket, connectionNumber) => {
        if (connectionNumber === 1) {
          socket.send(
            JSON.stringify({
              type: "error",
              error: {
                type: "model_at_capacity",
                message: "Selected model is at capacity. Please try a different model.",
              },
            })
          );
          return;
        }
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: "retry-ok" },
          })
        );
      },
    });
    const client = new WebSocket(harness.localUrl);
    await new Promise((resolve) => client.once("open", resolve));

    const received = new Promise<string>((resolve) => {
      client.once("message", (data) => resolve(data.toString()));
    });
    client.send(JSON.stringify({ type: "response.create", id: "capacity-turn" }));

    await expect(received).resolves.toContain("retry-ok");
    expect(harness.upstreamConnections).toBe(2);
    expect(
      harness.upstreamMessages.map((message) => JSON.parse(message).id)
    ).toEqual(["capacity-turn", "capacity-turn"]);

    // The account that reported capacity is cooled down so the *next* turn
    // (a fresh connection) prefers a different account instead of retrying
    // the same overloaded one again.
    const cooledMeta = harness.pool.store.get("acct-1")?.meta;
    expect(cooledMeta?.cooldownUntil).toBeDefined();
    expect(Date.parse(cooledMeta!.cooldownUntil!)).toBeGreaterThan(Date.now());

    client.close();
  });

  it("reconnects on another account after upstream drops the connection before responding", async () => {
    harness = await startWsHarness(0, {
      accountCount: 2,
      capacityRetryDelaysMs: [0],
      onUpstreamMessage: (socket, connectionNumber) => {
        if (connectionNumber === 1) {
          // Simulate the upstream dying mid-turn (no capacity frame, no
          // response.completed — just a dropped connection), the failure
          // mode behind "websocket closed by server before response.completed".
          socket.close(1011, "simulated upstream drop");
          return;
        }
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: "recovered" },
          })
        );
      },
    });
    const client = new WebSocket(harness.localUrl);
    await new Promise((resolve) => client.once("open", resolve));

    const received = new Promise<string>((resolve) => {
      client.once("message", (data) => resolve(data.toString()));
    });
    client.send(JSON.stringify({ type: "response.create", id: "drop-turn" }));

    await expect(received).resolves.toContain("recovered");
    expect(harness.upstreamConnections).toBe(2);
    expect(
      harness.upstreamMessages.map((message) => JSON.parse(message).id)
    ).toEqual(["drop-turn", "drop-turn"]);

    const cooledMeta = harness.pool.store.get("acct-1")?.meta;
    expect(cooledMeta?.cooldownUntil).toBeDefined();
    expect(Date.parse(cooledMeta!.cooldownUntil!)).toBeGreaterThan(Date.now());

    client.close();
  });

  it("resumes capacity retries for a later turn on the same long-lived connection", async () => {
    harness = await startWsHarness(0, {
      accountCount: 2,
      capacityRetryDelaysMs: [0],
      onUpstreamMessage: (socket, connectionNumber, message) => {
        const parsed = JSON.parse(message);
        if (connectionNumber === 1) {
          if (parsed.id === "turn-1") {
            socket.send(
              JSON.stringify({
                type: "response.completed",
                response: { id: "turn-1" },
              })
            );
            return;
          }
          // turn-2 arrives on the same still-open connection, after turn-1
          // already completed, and hits a capacity error.
          socket.send(
            JSON.stringify({
              type: "error",
              error: {
                type: "model_at_capacity",
                message: "Selected model is at capacity. Please try a different model.",
              },
            })
          );
          return;
        }
        // A different account (connection 2) completes turn-2.
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: "turn-2-ok" },
          })
        );
      },
    });

    const client = new WebSocket(harness.localUrl);
    await new Promise((resolve) => client.once("open", resolve));

    const messages: string[] = [];
    client.on("message", (data) => messages.push(data.toString()));

    client.send(JSON.stringify({ type: "response.create", id: "turn-1" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages.some((m) => m.includes("turn-1"))).toBe(true);

    client.send(JSON.stringify({ type: "response.create", id: "turn-2" }));
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const check = () => {
        if (messages.some((m) => m.includes("turn-2-ok"))) return resolve();
        if (Date.now() > deadline) return reject(new Error("timed out waiting for turn-2-ok"));
        setTimeout(check, 10);
      };
      check();
    });

    expect(harness.upstreamConnections).toBe(2);
    client.close();
  });

  it("does not replay after an upstream response has started", async () => {
    harness = await startWsHarness(0, {
      accountCount: 2,
      capacityRetryDelaysMs: [0],
      onUpstreamMessage: (socket) => {
        socket.send(
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "partial",
          })
        );
        socket.send(
          JSON.stringify({
            type: "error",
            error: { type: "model_at_capacity" },
          })
        );
      },
    });
    const client = new WebSocket(harness.localUrl);
    await new Promise((resolve) => client.once("open", resolve));

    const received: string[] = [];
    client.on("message", (data) => received.push(data.toString()));
    client.send(JSON.stringify({ type: "response.create", id: "partial-turn" }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(harness.upstreamConnections).toBe(1);
    expect(received.some((message) => message.includes("partial"))).toBe(true);
    expect(received.some((message) => message.includes("model_at_capacity"))).toBe(
      true
    );

    // Even though this turn couldn't be replayed, the account is still
    // cooled down so the next turn doesn't hit the same overloaded account.
    const cooledMeta = harness.pool.store.get("acct-1")?.meta;
    expect(cooledMeta?.cooldownUntil).toBeDefined();
    expect(Date.parse(cooledMeta!.cooldownUntil!)).toBeGreaterThan(Date.now());

    client.close();
  });
});
