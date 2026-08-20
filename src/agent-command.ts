import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32, type PlatformPath } from "node:path";
import { existsSync } from "node:fs";

/**
 * Finding the agent CLI and shutting it down are the two places where the platforms differ most.
 *
 * A macOS app started from the Dock does not inherit the shell PATH, so a `codex` that works in
 * Terminal is simply absent here; and a plain kill leaves whatever the agent itself started
 * running. Both are handled below, and the manual path in the settings stays the reliable door
 * when a version manager puts the binary somewhere no list can predict.
 */

export type AgentName = "codex" | "claude";
export type KillStrategy = "taskkill" | "process-group" | "direct";

export interface CommandLookup {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
}

interface ResolvedLookup {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ""];
const UNIX_PATH_ADDITIONS = ["/opt/homebrew/bin", "/usr/local/bin"];
const UNIX_HOME_PATH_ADDITIONS = [
  [".local", "bin"],
  [".npm-global", "bin"],
  [".bun", "bin"],
  [".volta", "bin"],
  [".cargo", "bin"]
];

function withDefaults(lookup: CommandLookup = {}): ResolvedLookup {
  return {
    platform: lookup.platform ?? process.platform,
    env: lookup.env ?? process.env,
    home: lookup.home ?? homedir(),
    exists: lookup.exists ?? existsSync
  };
}

/** Paths of the target platform, not of the one this code happens to run on. */
function pathApi(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return (key ? env[key] ?? "" : "")
    .split(pathApi(platform).delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

/**
 * Where each platform actually keeps these binaries. Kept apart per platform so that a Windows
 * location never turns into a stray relative path on macOS when its variable is unset.
 */
export function knownCommandLocations(agent: AgentName, lookup: CommandLookup = {}): string[] {
  const { platform, env, home } = withDefaults(lookup);
  const { join } = pathApi(platform);
  if (platform === "win32") {
    return [
      join(home, ".local", "bin", `${agent}.exe`),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs", agent, `${agent}.exe`)] : []),
      ...(env.APPDATA ? [join(env.APPDATA, "npm", `${agent}.cmd`)] : []),
      join(home, ".npm-global", `${agent}.cmd`)
    ];
  }
  const roots = platform === "darwin"
    ? UNIX_PATH_ADDITIONS
    : ["/usr/local/bin", "/usr/bin"];
  return [
    ...roots.map((root) => join(root, agent)),
    ...UNIX_HOME_PATH_ADDITIONS.map((segments) => join(home, ...segments, agent))
  ];
}

export function findInPath(command: string, lookup: CommandLookup = {}): string | null {
  const resolved = withDefaults(lookup);
  const { join } = pathApi(resolved.platform);
  const extensions = resolved.platform === "win32" ? WINDOWS_EXECUTABLE_EXTENSIONS : [""];
  for (const directory of pathEntries(resolved.env, resolved.platform)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (resolved.exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The path from the settings wins, then PATH, then the known locations. When nothing is found the
 * bare name is returned on purpose: the launch fails with a message that points at the setting,
 * instead of the plugin silently starting something else.
 */
export function resolveAgentCommand(
  configured: string,
  agent: AgentName,
  lookup: CommandLookup = {}
): string {
  const resolved = withDefaults(lookup);
  const custom = configured.trim();
  if (custom && custom !== agent) {
    if (pathApi(resolved.platform).isAbsolute(custom)) return custom;
    return findInPath(custom, resolved) ?? custom;
  }
  return findInPath(agent, resolved)
    ?? knownCommandLocations(agent, resolved).find(resolved.exists)
    ?? agent;
}

/**
 * Environment for the agent process. On Windows it drops the PowerShell stub directory that
 * shadows a real installation; on macOS and Linux it puts the usual install directories back into
 * PATH, which an app started from the Dock does not inherit.
 */
export function agentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): NodeJS.ProcessEnv {
  const env = { ...source };
  const { join, delimiter } = pathApi(platform);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

  if (platform === "win32") {
    const path = env[pathKey];
    if (!path) return env;
    const localWindowsApps = source.LOCALAPPDATA
      ? join(source.LOCALAPPDATA, "Microsoft", "WindowsApps").toLowerCase()
      : "";
    env[pathKey] = path
      .split(";")
      .filter((entry) => {
        const normalized = entry.trim().replace(/^"|"$/gu, "").replace(/[\\/]+$/u, "").toLowerCase();
        if (normalized.includes("\\windowsapps\\microsoft.powershell_")) return false;
        return !localWindowsApps || normalized !== localWindowsApps;
      })
      .join(";");
    return env;
  }

  const existing = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const additions = [
    ...(platform === "darwin" ? UNIX_PATH_ADDITIONS : ["/usr/local/bin"]),
    ...UNIX_HOME_PATH_ADDITIONS.map((segments) => join(home, ...segments))
  ].filter((directory) => !existing.includes(directory));
  env[pathKey] = [...existing, ...additions].join(delimiter);
  return env;
}

export function killStrategy(platform: NodeJS.Platform = process.platform): KillStrategy {
  return platform === "win32" ? "taskkill" : "process-group";
}

/** Non-Windows children are spawned in their own process group so the group can be killed whole. */
export function spawnsDetached(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Ends the agent and everything it started. `child.kill()` on its own signals the agent process
 * only, which would leave the commands it launched running.
 */
export function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  forceDelayMs = 2000
): void {
  if (child.killed || !child.pid) {
    child.kill();
    return;
  }
  if (killStrategy(platform) === "taskkill") {
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    if (result.status === 0) return;
    child.kill();
    return;
  }

  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  }, forceDelayMs);
  force.unref?.();
  child.once("exit", () => clearTimeout(force));
}
