import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const nodeArgs = ["--import", import.meta.resolve("tsx"), cli];

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "osa-cli-config-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.OPENSUPERAGENT_CONFIG;
  delete env.OPENSUPERAGENT_DATA_ROOT;
  delete env.OPENSUPERAGENT_ADMIN_TOKEN;
  const options = { cwd, env };
  const globalConfig = join(home, ".opensuperagent", "config.yaml");
  const localConfig = join(cwd, "config.yaml");
  const envConfig = join(root, "environment", "config.json");
  const explicitConfig = join(root, "explicit", "config.json");

  function config(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        instance: { data_root: "./data" },
        console: { listen: "127.0.0.1:0" },
        sources: [],
      }),
    );
    return join(dirname(file), "data");
  }

  function run(args: string[]) {
    return spawnSync(process.execPath, [...nodeArgs, ...args], {
      ...options,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  async function serve(args: string[]) {
    const child = spawn(process.execPath, [...nodeArgs, "serve", ...args], options);
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    let output = "";
    let errors = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`CLI startup timed out: ${output}${errors}`));
        }, 10_000);
        child.stdout.on("data", (data) => {
          output += data;
          if (output.includes("[api] listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr.on("data", (data) => {
          errors += data;
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`CLI exited with ${code}: ${output}${errors}`));
        });
      });
      return output;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await closed;
      clearTimeout(timer);
    }
  }

  return {
    home, env, globalConfig, localConfig, envConfig, explicitConfig, config, run, serve,
  };
}

it("prints version and help without creating a data directory", (t) => {
  const f = fixture(t);
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  for (const flag of ["--version", "-v"]) {
    const result = f.run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `opensuperagent ${pkg.version}`);
  }
  for (const flag of ["--help", "-h"]) {
    const result = f.run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^opensuperagent <command>/);
    assert.match(result.stdout, /--version/);
  }
  assert.equal(existsSync(f.globalConfig), false);
});

for (const selected of ["explicit", "environment", "local", "global"] as const) {
  it(`init and other CLI commands select the ${selected} config by priority`, (t) => {
    const f = fixture(t);
    const roots = {
      global: f.config(f.globalConfig),
      ...(selected !== "global" ? { local: f.config(f.localConfig) } : {}),
      ...(selected === "environment" || selected === "explicit"
        ? { environment: f.config(f.envConfig) }
        : {}),
      ...(selected === "explicit" ? { explicit: f.config(f.explicitConfig) } : {}),
    };
    if (selected === "environment" || selected === "explicit") {
      f.env.OPENSUPERAGENT_CONFIG = f.envConfig;
    }
    const flags = selected === "explicit" ? ["--config", f.explicitConfig] : [];
    const init = f.run(["init", ...flags]);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(init.stdout.includes(`Data root: ${roots[selected]}\n`), init.stdout);
    for (const [name, root] of Object.entries(roots)) {
      assert.equal(existsSync(join(root, "state.sqlite")), name === selected, name);
    }
    const skills = f.run(["skill", "list", ...flags]);
    assert.equal(skills.status, 0, skills.stderr);
    assert.match(skills.stdout, /^api-contract\t/m);
    const definition = f.run(["def", "export", "coding", ...flags]);
    assert.equal(definition.status, 0, definition.stderr);
    assert.equal(JSON.parse(definition.stdout).id, "coding");
  });
}

for (const explicit of [false, true]) {
  it(`init and serve use the same data root with ${explicit ? "explicit and environment" : "environment"} config`, async (t) => {
    const f = fixture(t);
    const envRoot = f.config(f.envConfig);
    const expectedRoot = explicit ? f.config(f.explicitConfig) : envRoot;
    f.env.OPENSUPERAGENT_CONFIG = f.envConfig;
    const flags = explicit ? ["--config", f.explicitConfig] : [];
    const init = f.run(["init", ...flags]);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(init.stdout.includes(`Data root: ${expectedRoot}\n`), init.stdout);
    const output = await f.serve(flags);
    assert.ok(output.includes(`[app] data_root=${expectedRoot}\n`), output);
    assert.equal(existsSync(f.globalConfig), false);
  });
}

it("creates a user-level config only when no config was selected or discovered", (t) => {
  const f = fixture(t);
  const result = f.run(["init"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Wrote ${f.globalConfig}\n`), result.stdout);
  assert.ok(result.stdout.includes(`Data root: ${join(f.home, ".opensuperagent")}\n`));
  const contents = readFileSync(f.globalConfig, "utf8");
  const again = f.run(["init"]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /Wrote /);
  assert.equal(readFileSync(f.globalConfig, "utf8"), contents);
});

for (const via of ["environment", "explicit"] as const) {
  it(`rejects a missing ${via} config without initializing a fallback`, (t) => {
    const f = fixture(t);
    const fallback = f.config(f.localConfig);
    f.config(f.globalConfig);
    f.env.OPENSUPERAGENT_CONFIG = f.envConfig;
    const flags = via === "explicit" ? ["--config", f.explicitConfig] : [];
    for (const command of [["init"], ["serve"], ["skill", "list"], ["def", "export", "coding"]]) {
      const result = f.run([...command, ...flags]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Config not found:/);
    }
    assert.equal(existsSync(join(fallback, "state.sqlite")), false);
    assert.equal(existsSync(join(f.home, ".opensuperagent", "data")), false);
    assert.equal(existsSync(f.envConfig), false);
    assert.equal(existsSync(f.explicitConfig), false);
  });
}

for (const command of [["init"], ["serve"], ["skill", "list"], ["def", "export", "coding"]]) {
  it(`${command.join(" ")} rejects --config without a path before touching data`, (t) => {
    const f = fixture(t);
    const dataRoot = f.config(f.envConfig);
    f.env.OPENSUPERAGENT_CONFIG = f.envConfig;
    for (const value of [[], [""], ["--help"]]) {
      const result = f.run([...command, "--config", ...value]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /--config requires a file path/);
      assert.equal(existsSync(dataRoot), false);
      assert.equal(existsSync(f.globalConfig), false);
    }
  });
}
