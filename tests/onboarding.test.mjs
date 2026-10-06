import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { initConfig } from "../dist/config.js";
import { prepareProjectMcp, prepareCodex } from "../dist/onboarding.js";
import { atomicText } from "../dist/storage.js";

test("project MCP config binds exact runtime paths, is repeatable and preserves existing settings", (t) => {
  const root = mkdtempSync("/private/tmp/c2c-onboarding-");
  const c = initConfig(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(c.socket, ".."), { recursive: true, force: true });
  });
  const cli = "/private/tmp/runtime with spaces/dist/cli.js";
  const path = prepareProjectMcp(c, cli, "/opt/example node");
  const original = readFileSync(path, "utf8");
  assert.match(original, /\[mcp_servers.codex2claude\]/);
  assert.match(original, /cwd = /);
  assert.ok(original.includes(JSON.stringify(cli)));
  assert.equal(prepareProjectMcp(c, cli, "/opt/example node"), path);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.throws(
    () => prepareProjectMcp(c, "/new/runtime/cli.js", "/new/node"),
    /existing_codex_config_conflict/,
  );
  prepareProjectMcp(c, "/new/runtime/cli.js", "/new/node", true);
  const refreshed = readFileSync(path, "utf8");
  assert.ok(refreshed.includes('command = "/new/node"'));
  assert.ok(refreshed.includes(JSON.stringify(c.root)));
  // Even the generated marker must not authorize overwriting user additions.
  writeFileSync(path, refreshed + 'model = "user-added-setting"\n');
  assert.throws(
    () => prepareProjectMcp(c, cli, "/opt/example node", true),
    /existing_codex_config_conflict/,
  );
  assert.equal(
    readFileSync(path, "utf8"),
    refreshed + 'model = "user-added-setting"\n',
  );
  const otherSettings = 'model = "user-setting"\n';
  writeFileSync(path, otherSettings);
  assert.throws(
    () => prepareProjectMcp(c, cli),
    /existing_codex_config_conflict/,
  );
  assert.equal(readFileSync(path, "utf8"), otherSettings);
  assert.throws(() => atomicText(path, "replacement", false), /EEXIST/);
  assert.equal(readFileSync(path, "utf8"), otherSettings);
});

test("catalog onboarding refuses outside paths and preflights config before creating files", (t) => {
  const root = mkdtempSync("/private/tmp/c2c-catalog-");
  const outside = mkdtempSync("/private/tmp/c2c-catalog-outside-");
  const c = initConfig(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(c.socket, ".."), { recursive: true, force: true });
  });
  symlinkSync(outside, join(root, ".agents"));
  assert.throws(
    () => prepareCodex(c, "/tmp/cli.js", true),
    /unsafe_marketplace_directory/,
  );
  assert.equal(existsSync(join(outside, "plugins")), false);
  rmSync(join(root, ".agents"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex/config.toml"), 'model = "existing"\n');
  assert.throws(
    () => prepareCodex(c, "/tmp/cli.js", true),
    /existing_codex_config_conflict/,
  );
  assert.equal(existsSync(join(root, ".agents")), false);
  rmSync(join(root, ".codex/config.toml"));
  const prepared = prepareCodex(c, "/tmp/cli.js", true);
  assert.ok(existsSync(prepared.marketplace));
  assert.ok(existsSync(prepared.project_mcp_config));
  rmSync(prepared.marketplace);
  symlinkSync(join(outside, "missing.json"), prepared.marketplace);
  assert.throws(
    () => prepareCodex(c, "/tmp/cli.js", true),
    /unsafe_marketplace_file/,
  );
});

test("project onboarding refuses symlinks into another configuration directory", (t) => {
  const root = mkdtempSync("/private/tmp/c2c-onboarding-links-");
  const outside = mkdtempSync("/private/tmp/c2c-other-config-");
  const c = initConfig(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(c.socket, ".."), { recursive: true, force: true });
  });
  const other = join(outside, "config.toml");
  writeFileSync(other, "original settings\n");
  symlinkSync(outside, join(root, ".codex"));
  assert.throws(
    () => prepareProjectMcp(c, "/tmp/cli.js"),
    /unsafe_codex_config_directory/,
  );
  rmSync(join(root, ".codex"));
  mkdirSync(join(root, ".codex"));
  symlinkSync(other, join(root, ".codex/config.toml"));
  assert.throws(
    () => prepareProjectMcp(c, "/tmp/cli.js"),
    /unsafe_codex_config_file/,
  );
  assert.equal(readFileSync(other, "utf8"), "original settings\n");
  rmSync(join(root, ".codex/config.toml"));
  symlinkSync(join(outside, "missing.toml"), join(root, ".codex/config.toml"));
  assert.throws(
    () => prepareProjectMcp(c, "/tmp/cli.js"),
    /unsafe_codex_config_file/,
  );
});
