// The RPC order and fallback, against local servers that answer like the public endpoints do
// when they refuse: 429 (fastnear's free tier per IP) and 408 (dRPC on a long request).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { rpcOrder, viewFunction } from "./near.ts";

async function serve(handler: (n: number) => { status: number; body?: unknown }): Promise<{ url: string; server: Server; calls: () => number }> {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const r = handler(++n);
      res.writeHead(r.status, { "content-type": "application/json" }).end(r.body === undefined ? "" : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, calls: () => n };
}

const ok = (value: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: "weir", result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } } });

test("dRPC is asked first, fastnear second, anything else after", () => {
  assert.deepEqual(rpcOrder(["https://test.rpc.fastnear.com", "https://other.example", "https://near-testnet.drpc.org"]), ["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com", "https://other.example"]);
});

test("a 429 or a 408 from one endpoint falls through to the next", async () => {
  for (const status of [429, 408, 503]) {
    const a = await serve(() => ({ status }));
    const b = await serve(() => ok({ now: 7 }));
    try {
      assert.deepEqual(await viewFunction([a.url, b.url], "c.testnet", "get_status"), { now: 7 });
      assert.equal(a.calls(), 1);
      assert.equal(b.calls(), 1);
    } finally {
      a.server.close();
      b.server.close();
    }
  }
});

test("when every endpoint fails, the error says which one said what", async () => {
  const a = await serve(() => ({ status: 429 }));
  const b = await serve(() => ({ status: 408 }));
  try {
    await assert.rejects(viewFunction([a.url, b.url], "c.testnet", "get_status"), (e: Error) => {
      assert.match(e.message, new RegExp(`${new URL(a.url).host} answered HTTP 429; ${new URL(b.url).host} answered HTTP 408`));
      return true;
    });
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("a contract error is not retried on the next endpoint", async () => {
  const a = await serve(() => ({ status: 200, body: { jsonrpc: "2.0", id: "weir", error: { message: "x", data: "wasm execution failed", cause: { name: "CONTRACT_EXECUTION_ERROR" } } } }));
  const b = await serve(() => ok(1));
  try {
    await assert.rejects(viewFunction([a.url, b.url], "c.testnet", "get_round"), /CONTRACT_EXECUTION_ERROR/);
    assert.equal(b.calls(), 0);
  } finally {
    a.server.close();
    b.server.close();
  }
});
