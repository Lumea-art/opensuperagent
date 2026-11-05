import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync } from "node:fs";
import { SettingsStore } from "../src/settings/store.js";
import { temporaryApp, httpServer, jsonBody } from "./helpers/harness.js";

describe("runtime model configuration", () => {
  it("tests saved adapter credentials while disabled, refreshes rotated credentials and reports safe platform codes", async () => {
    const appIds: string[] = [];
    const remote = await httpServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.includes("tenant_access_token")) {
        const body = await jsonBody(req);
        appIds.push(body.app_id);
        res.end(
          JSON.stringify(
            body.app_id === "denied"
              ? {
                  code: 21001,
                  msg: "Do not disclose sensitive-platform-detail",
                }
              : {
                  code: 0,
                  tenant_access_token: `secret-token-${body.app_id}`,
                  expire: 7200,
                },
          ),
        );
      } else if (req.url?.includes("/chats")) {
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              items: [{ chat_id: "oc_test", name: "Integration test" }],
              has_more: false,
            },
          }),
        );
      } else res.end(JSON.stringify({ full_name: "owner/test" }));
    });
    const h = temporaryApp();
    await h.api.start();
    const probe = (name: string) =>
      fetch(`${h.api.url}/api/settings/adapters/${name}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    try {
      h.app.settings.saveAdapter("github", {
        token: "github-secret",
        repos: ["owner/test"],
        apiBaseUrl: remote.url,
      });
      assert.equal((await probe("github")).status, 200);
      for (const appId of ["one", "two", "denied"]) {
        h.app.settings.saveAdapter("feishu", {
          appId,
          appSecret: "feishu-secret",
          apiBaseUrl: remote.url,
        });
        const response = await probe("feishu");
        const text = await response.text();
        assert.ok(
          !/secret-token|feishu-secret|sensitive-platform-detail/.test(text),
        );
        if (appId === "denied") {
          assert.equal(response.status, 400);
          assert.ok(text.includes("21001"));
        } else {
          assert.equal(response.status, 200);
          assert.deepEqual(JSON.parse(text).chats, [
            { id: "oc_test", name: "Integration test" },
          ]);
          await probe("feishu");
        }
      }
      assert.deepEqual(appIds, ["one", "two", "denied"]);
    } finally {
      await h.close();
      await remote.close();
    }
  });
  it("saves keys atomically without disclosing them, preserves blank keys, validates references and reloads routes", async () => {
    const h = temporaryApp();
    await h.api.start();
    const request = (path: string, body?: unknown, method = "PUT") =>
      fetch(h.api.url + path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const provider = {
        id: "local",
        name: "Local gateway",
        protocol: "openai-compatible",
        baseUrl: "http://127.0.0.1:9999/v1",
        apiKey: "sensitive-provider-key",
        models: ["local-small", "local-large"],
        maxTokens: 512,
      };
      const saved = await request("/api/settings/providers", provider);
      assert.equal(saved.status, 200);
      const view = await saved.text();
      assert.ok(!view.includes(provider.apiKey));
      assert.ok(view.includes("apiKeyConfigured"));
      assert.equal(statSync(h.app.settings.file).mode & 0o777, 0o600);
      assert.equal(statSync(h.dir + "/secrets").mode & 0o777, 0o700);
      await request("/api/settings/providers", {
        ...provider,
        apiKey: "",
        name: "Updated",
      });
      assert.equal(h.app.settings.provider("local").apiKey, provider.apiKey);
      const routing = {
        router: { providerId: "local", model: "local-small" },
        worker: { providerId: "local", model: "local-large" },
        profiles: {
          "worker-fast": { providerId: "local", model: "local-small" },
        },
      };
      assert.equal(
        (await request("/api/settings/routing", routing)).status,
        200,
      );
      assert.equal(
        (await request("/api/settings/providers/local", undefined, "DELETE"))
          .status,
        409,
      );
      const reloaded = new SettingsStore(h.dir);
      assert.equal(
        reloaded.resolve("worker", "worker-fast").workerModel,
        "local-small",
      );
      assert.equal(
        reloaded.resolve("worker", "unknown").workerModel,
        "local-large",
      );
      const invalid = await request("/api/settings/providers", {
        ...provider,
        baseUrl: "file:///etc/passwd",
      });
      assert.equal(invalid.status, 400);
      const badOrigin = await fetch(h.api.url + "/api/settings/providers", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://untrusted.example",
        },
        body: JSON.stringify(provider),
      });
      assert.equal(badOrigin.status, 403);
      await badOrigin.text();
      const malformedOrigin = await fetch(h.api.url + "/api/settings/providers", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "not-a-url",
        },
        body: JSON.stringify(provider),
      });
      assert.equal(malformedOrigin.status, 403);
      await malformedOrigin.text();
      h.app.config.console.admin_token = "admin-test";
      assert.equal((await fetch(h.api.url + "/api/settings")).status, 401);
      const authorized = await fetch(h.api.url + "/api/settings", {
        headers: { Authorization: "Bearer admin-test" },
      });
      assert.equal(authorized.status, 200);
      assert.ok(!(await authorized.text()).includes(provider.apiKey));
      assert.ok(
        readFileSync(h.app.settings.file, "utf8").includes(provider.apiKey),
      );
    } finally {
      await h.close();
    }
  });
  it("discovers models and performs real HTTP model tests for both supported protocols", async () => {
    const requests: any[] = [];
    const remote = await httpServer(async (req, res) => {
      const body = await jsonBody(req);
      requests.push({
        path: req.url,
        body,
        authorization: req.headers.authorization,
        key: req.headers["x-api-key"],
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/v1/models"
            ? { data: [{ id: "model-a" }, { id: "model-b" }] }
            : req.url === "/v1/messages"
              ? {
                  content: [{ type: "text", text: "OK" }],
                  stop_reason: "end_turn",
                  usage: { input_tokens: 2, output_tokens: 1 },
                }
              : {
                  choices: [
                    {
                      message: { role: "assistant", content: "OK" },
                      finish_reason: "stop",
                    },
                  ],
                },
        ),
      );
    });
    const h = temporaryApp();
    await h.api.start();
    try {
      for (const protocol of ["openai-compatible", "anthropic"] as const) {
        h.app.settings.saveProvider({
          id: protocol,
          name: protocol,
          protocol,
          baseUrl: remote.url + "/v1",
          apiKey: "model-secret",
          models: ["model-a"],
        });
        for (const action of ["models", "test"]) {
          const response = await fetch(
            `${h.api.url}/api/settings/providers/${protocol}/${action}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: "model-a" }),
            },
          );
          assert.equal(response.status, 200);
          const result = (await response.json()) as any;
          if (action === "models")
            assert.deepEqual(result.models, ["model-a", "model-b"]);
          else assert.equal(result.ok, true);
        }
      }
      assert.equal(
        requests.find((r) => r.path === "/v1/messages").key,
        "model-secret",
      );
      assert.equal(
        requests.find((r) => r.path === "/v1/chat/completions").authorization,
        "Bearer model-secret",
      );
    } finally {
      await h.close();
      await remote.close();
    }
  });
});
