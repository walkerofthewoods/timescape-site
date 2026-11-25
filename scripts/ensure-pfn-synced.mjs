import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { basename, resolve, win32 } from "node:path"
import { pathToFileURL } from "node:url"
import {
  checkPlayerFacingSync,
  DEFAULT_ALLOWED_ASSET_DIRS,
  DEFAULT_PLAYER_FACING_DIR,
} from "./sync-vault.mjs"

export const DEFAULT_PFN_COMMAND_ID = "player-facing-notes:sync-vault"

function parseAllowedAssetDirs(raw) {
  if (!raw || !raw.trim()) return [...DEFAULT_ALLOWED_ASSET_DIRS]
  return raw
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .replaceAll("\\", "/")
        .replace(/^(?:\.\/|\/)+|\/+$/g, ""),
    )
    .filter(Boolean)
}

export function resolveObsidianCliCandidates(env = process.env, platform = process.platform) {
  const candidates = []
  const addCandidate = (value) => {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed)
    }
  }

  addCandidate(env.OBSIDIAN_CLI)
  addCandidate("obsidian")

  if (platform === "win32") {
    const winJoin = win32.join
    addCandidate("obsidian.com")
    if (env.LOCALAPPDATA) {
      addCandidate(winJoin(env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.com"))
      addCandidate(winJoin(env.LOCALAPPDATA, "Obsidian", "Obsidian.com"))
    }
    if (env.ProgramFiles) {
      addCandidate(winJoin(env.ProgramFiles, "Obsidian", "Obsidian.com"))
    }
    if (env["ProgramFiles(x86)"]) {
      addCandidate(winJoin(env["ProgramFiles(x86)"], "Obsidian", "Obsidian.com"))
    }
  }

  return candidates
}

export function defaultRunObsidianCommand({ vaultName, commandId = DEFAULT_PFN_COMMAND_ID }) {
  const args = vaultName
    ? [`vault=${vaultName}`, "command", `id=${commandId}`]
    : ["command", `id=${commandId}`]

  for (const executable of resolveObsidianCliCandidates()) {
    const isExplicitPath = executable.includes("/") || executable.includes("\\")
    if (isExplicitPath && !existsSync(executable)) continue

    const result = spawnSync(executable, args, {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
    })

    if (result.error?.code === "ENOENT") continue

    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stderr: (result.stderr ?? "").trim(),
      error: result.error?.message,
      executable,
    }
  }

  return {
    ok: false,
    status: null,
    stderr: "",
    error:
      "Obsidian CLI not found on PATH or standard install locations (set OBSIDIAN_CLI or restart your terminal).",
  }
}

export function defaultOpenVaultInObsidian(vaultName) {
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}`

  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/c", "start", "", uri], {
      stdio: "ignore",
      shell: false,
      timeout: 5_000,
    })
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open"
  return spawnSync(opener, [uri], {
    stdio: "ignore",
    shell: false,
    timeout: 5_000,
  })
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export async function ensurePlayerFacingSynced({
  vaultDirectory,
  vaultName,
  playerFacingDirName = DEFAULT_PLAYER_FACING_DIR,
  allowedAssetDirs = DEFAULT_ALLOWED_ASSET_DIRS,
  commandId = DEFAULT_PFN_COMMAND_ID,
  checkOnly = false,
  timeoutMs = 25_000,
  pollIntervalMs = 500,
  retryTriggerAfterMs = 2_500,
  now = () => Date.now(),
  sleep = defaultSleep,
  checkDrift,
  runObsidianCommand = defaultRunObsidianCommand,
  openVaultInObsidian = defaultOpenVaultInObsidian,
} = {}) {
  let runDriftCheck = checkDrift
  if (!runDriftCheck) {
    if (!vaultDirectory || !vaultDirectory.trim()) {
      throw new Error("Vault path is required.")
    }

    const resolvedVault = resolve(vaultDirectory)
    if (!existsSync(resolvedVault) || !statSync(resolvedVault).isDirectory()) {
      throw new Error(`Vault directory not found: ${resolvedVault}`)
    }

    const playerFacingDirectory = resolve(resolvedVault, ...playerFacingDirName.split("/"))
    if (!existsSync(playerFacingDirectory) || !statSync(playerFacingDirectory).isDirectory()) {
      throw new Error(`Player-facing directory not found: ${playerFacingDirectory}`)
    }

    const allowedAssetDirPaths = allowedAssetDirs.map((dir) =>
      resolve(resolvedVault, ...dir.replaceAll("\\", "/").split("/").filter(Boolean)),
    )

    runDriftCheck = () =>
      checkPlayerFacingSync({
        vaultDirectory: resolvedVault,
        playerFacingDirectory,
        playerFacingDirName,
        allowedAssetDirPaths,
      })
  }

  let drift = runDriftCheck()
  if (drift.length === 0) {
    return {
      status: "clean",
      attempts: 1,
      triggered: false,
      launchedObsidian: false,
      drift: [],
    }
  }

  if (checkOnly) {
    return {
      status: "stale",
      attempts: 1,
      triggered: false,
      launchedObsidian: false,
      drift,
    }
  }

  let launchedObsidian = false
  const firstTrigger = runObsidianCommand({ vaultName, commandId })
  if (!firstTrigger.ok) {
    const targetVaultName =
      vaultName || (vaultDirectory ? basename(resolve(vaultDirectory)) : "vault")
    openVaultInObsidian(targetVaultName)
    launchedObsidian = true
  }

  const startedAt = now()
  let attempts = 1
  let commandSucceeded = firstTrigger.ok
  let lastTriggerAt = startedAt
  let retriedAfterSuccess = false
  let lastCommandError = !firstTrigger.ok
    ? firstTrigger.stderr || firstTrigger.error || undefined
    : undefined

  while (now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs)
    attempts++
    drift = runDriftCheck()
    if (drift.length === 0) {
      return {
        status: "synced",
        attempts,
        triggered: true,
        launchedObsidian,
        drift: [],
      }
    }

    if (!commandSucceeded && now() - lastTriggerAt >= retryTriggerAfterMs) {
      lastTriggerAt = now()
      const retry = runObsidianCommand({ vaultName, commandId })
      if (retry.ok) {
        commandSucceeded = true
        lastCommandError = undefined
      } else {
        lastCommandError = retry.stderr || retry.error || lastCommandError
      }
    } else if (
      commandSucceeded &&
      !retriedAfterSuccess &&
      now() - lastTriggerAt >= retryTriggerAfterMs * 2
    ) {
      retriedAfterSuccess = true
      lastTriggerAt = now()
      const retry = runObsidianCommand({ vaultName, commandId })
      if (!retry.ok) {
        lastCommandError = retry.stderr || retry.error || lastCommandError
      }
    }
  }

  return {
    status: "stale",
    attempts,
    triggered: true,
    launchedObsidian,
    drift,
    ...(lastCommandError ? { lastCommandError } : {}),
  }
}

function parseCliArgs(argv) {
  let vaultPath
  let vaultName
  let timeoutSeconds = 25
  let checkOnly = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") continue

    if (arg === "--check-only") {
      checkOnly = true
    } else if (arg === "--vault-name") {
      vaultName = argv[++i]
    } else if (arg.startsWith("--vault-name=")) {
      vaultName = arg.slice("--vault-name=".length)
    } else if (arg === "--timeout") {
      timeoutSeconds = Number(argv[++i])
    } else if (arg.startsWith("--timeout=")) {
      timeoutSeconds = Number(arg.slice("--timeout=".length))
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`)
    } else if (!vaultPath) {
      vaultPath = arg
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error("--timeout must be a non-negative number of seconds.")
  }

  return {
    vaultPath: vaultPath ?? process.env.TIMESCAPE_VAULT,
    vaultName: vaultName?.trim() || process.env.TIMESCAPE_VAULT_NAME?.trim() || undefined,
    timeoutMs: timeoutSeconds * 1000,
    checkOnly,
  }
}

async function main() {
  let parsed
  try {
    parsed = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  if (!parsed.vaultPath || !parsed.vaultPath.trim()) {
    console.error(
      "Vault path is required. Pass it as an argument (`node scripts/ensure-pfn-synced.mjs <path>`) or set TIMESCAPE_VAULT.",
    )
    process.exit(1)
  }

  let result
  try {
    result = await ensurePlayerFacingSynced({
      vaultDirectory: parsed.vaultPath,
      vaultName: parsed.vaultName,
      allowedAssetDirs: parseAllowedAssetDirs(process.env.TIMESCAPE_ASSET_DIRS),
      timeoutMs: parsed.timeoutMs,
      checkOnly: parsed.checkOnly,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  if (result.status === "clean") {
    console.log("Player-facing exports are up to date.")
    return
  }

  if (result.status === "synced") {
    console.log("Player-facing exports synced via Obsidian.")
    return
  }

  if (result.lastCommandError) {
    console.error(`Obsidian CLI error: ${result.lastCommandError}`)
  }
  console.error(
    "Player-facing exports are still out of date with source notes (open Obsidian and run 'Player Facing Notes: Sync vault', or bypass a git hook with --no-verify):",
  )
  for (const issue of result.drift) {
    console.error(`- ${issue}`)
  }
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
