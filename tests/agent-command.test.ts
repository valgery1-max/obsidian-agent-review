import assert from "node:assert/strict";
import test from "node:test";
import {
  agentEnvironment,
  findInPath,
  killStrategy,
  knownCommandLocations,
  resolveAgentCommand,
  spawnsDetached
} from "../src/agent-command";

const MAC_HOME = "/test-home";
const WINDOWS_HOME = "C:\\TestHome";

function macLookup(present: string[] = [], path = "/usr/bin:/bin") {
  return {
    platform: "darwin" as NodeJS.Platform,
    env: { PATH: path },
    home: MAC_HOME,
    exists: (candidate: string) => present.includes(candidate)
  };
}

test("keeps the candidate locations of each platform apart", () => {
  const mac = knownCommandLocations("codex", macLookup());
  const windows = knownCommandLocations("codex", {
    platform: "win32",
    env: {},
    home: WINDOWS_HOME,
    exists: () => false
  });

  assert.equal(mac.includes("/opt/homebrew/bin/codex"), true);
  assert.equal(mac.some((path) => path.endsWith(".exe") || path.endsWith(".cmd")), false);
  assert.equal(windows.every((path) => path.startsWith(WINDOWS_HOME)), true);
  assert.equal(mac.every((path) => path.startsWith("/")), true);
});

test("does not invent a relative path when a Windows variable is missing", () => {
  const windows = knownCommandLocations("claude", {
    platform: "win32",
    env: {},
    home: WINDOWS_HOME,
    exists: () => false
  });

  assert.equal(windows.some((path) => path.startsWith("Programs")), false);
  assert.equal(windows.every((path) => path.includes(":\\") || path.startsWith("\\")), true);
});

test("takes the path from the settings before anything else", () => {
  const resolved = resolveAgentCommand("/test-home/bin/codex-dev", "codex", macLookup([
    "/opt/homebrew/bin/codex",
    "/test-home/bin/codex-dev"
  ]));

  assert.equal(resolved, "/test-home/bin/codex-dev");
});

test("keeps a manual path that does not exist so the error can name it", () => {
  const resolved = resolveAgentCommand("/opt/nowhere/codex", "codex", macLookup([]));

  assert.equal(resolved, "/opt/nowhere/codex");
});

test("prefers PATH over the known locations", () => {
  const resolved = resolveAgentCommand("codex", "codex", macLookup(
    ["/test-home/.nvm/versions/node/v22.0.0/bin/codex", "/opt/homebrew/bin/codex"],
    "/usr/bin:/test-home/.nvm/versions/node/v22.0.0/bin"
  ));

  assert.equal(resolved, "/test-home/.nvm/versions/node/v22.0.0/bin/codex");
});

test("falls back to the known locations when PATH is the one of a Dock-started app", () => {
  const resolved = resolveAgentCommand("codex", "codex", macLookup(
    ["/opt/homebrew/bin/codex"],
    "/usr/bin:/bin:/usr/sbin:/sbin"
  ));

  assert.equal(resolved, "/opt/homebrew/bin/codex");
});

test("returns the bare name when nothing is found, so the launch error points at the setting", () => {
  assert.equal(resolveAgentCommand("codex", "codex", macLookup([])), "codex");
  assert.equal(resolveAgentCommand("", "claude", macLookup([])), "claude");
});

test("finds a Windows executable by its extension", () => {
  const found = findInPath("claude", {
    platform: "win32",
    env: { Path: "C:\\tools;C:\\npm" },
    home: WINDOWS_HOME,
    exists: (candidate) => candidate === "C:\\npm\\claude.cmd"
  });

  assert.equal(found, "C:\\npm\\claude.cmd");
});

test("puts the usual install directories back into PATH outside Windows", () => {
  const env = agentEnvironment({ PATH: "/usr/bin:/bin" }, "darwin", MAC_HOME);
  const entries = (env.PATH ?? "").split(":");

  assert.equal(entries.includes("/usr/bin"), true);
  assert.equal(entries.includes("/opt/homebrew/bin"), true);
  assert.equal(entries.includes("/test-home/.local/bin"), true);
  assert.equal(entries.filter((entry) => entry === "/usr/bin").length, 1);
});

test("does not duplicate a directory that PATH already has", () => {
  const env = agentEnvironment({ PATH: "/opt/homebrew/bin:/usr/bin" }, "darwin", MAC_HOME);

  assert.equal((env.PATH ?? "").split(":").filter((entry) => entry === "/opt/homebrew/bin").length, 1);
});

test("still drops the PowerShell stub directory on Windows", () => {
  const env = agentEnvironment({
    Path: [
      "C:\\Windows\\System32",
      "C:\\TestHome\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe",
      "C:\\TestHome\\AppData\\Local\\Microsoft\\WindowsApps"
    ].join(";"),
    LOCALAPPDATA: "C:\\TestHome\\AppData\\Local"
  }, "win32", WINDOWS_HOME);

  assert.equal(env.Path, "C:\\Windows\\System32");
});

test("ends the whole process group outside Windows", () => {
  assert.equal(killStrategy("win32"), "taskkill");
  assert.equal(killStrategy("darwin"), "process-group");
  assert.equal(killStrategy("linux"), "process-group");
  assert.equal(spawnsDetached("darwin"), true);
  assert.equal(spawnsDetached("win32"), false);
});
