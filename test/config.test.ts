import { it } from "node:test";
import assert from "node:assert/strict";
import { parseListen } from "../src/config.js";

it("parses IPv4, hostnames and bare ports", () => {
  assert.deepEqual(parseListen("127.0.0.1:7420"), {
    host: "127.0.0.1",
    port: 7420,
  });
  assert.deepEqual(parseListen("localhost:7420"), {
    host: "localhost",
    port: 7420,
  });
  assert.deepEqual(parseListen("7420"), { host: "127.0.0.1", port: 7420 });
});

it("parses bracketed IPv6 hosts", () => {
  assert.deepEqual(parseListen("[::1]:7420"), { host: "::1", port: 7420 });
  assert.deepEqual(parseListen("[::]:0"), { host: "::", port: 0 });
});

it("rejects malformed listen values", () => {
  for (const value of [
    "",
    "[::1]",
    "[::1]:",
    "[]:7420",
    "localhost:not-a-port",
    "localhost:70000",
    "a:b:7420",
  ]) {
    assert.throws(() => parseListen(value), {
      message: `Invalid console.listen: ${value}`,
    });
  }
});
