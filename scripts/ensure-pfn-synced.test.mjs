import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import {
  DEFAULT_PFN_COMMAND_ID,
  ensurePlayerFacingSynced,
  resolveObsidianCliCandidates,
} from "./ensure-pfn-synced.mjs"

function writeFixtureFile(root, relPath, content = "") {
  const fullPath = join(root, ...relPath.split("/"))
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, "utf8")
}

test("ensurePlayerFacingSynced returns clean immediately without launching Obsidian", async () => {
  const root = mkdtempSync(join(tmpdir(), "timescape-pfn-clean-"))
  const vault = join(root, "TimescapeVault")
  mkdirSync(join(vault, "z_player_facing"), { recursive: true })
  try {
    writeFixtureFile(vault, "Lore.md", "::pf\nPublic lore\n::/pf\n")
    writeFixtureFile(
      vault,
      "z_player_facing/Lore.md",
      '---\npublish: true\npfn-source: "Lore.md"\n---\nPublic lore\n',
    )

    let commandCalls = 0
    let openCalls = 0
    const result = await ensurePlayerFacingSynced({
      vaultDirectory: vault,
      runObsidianCommand: () => {
        commandCalls++
        return { ok: true, status: 0, stderr: "" }
      },
      openVaultInObsidian: () => {
        openCalls++
      },
    })

    assert.deepEqual(result, {
      status: "clean",
      attempts: 1,
      triggered: false,
      launchedObsidian: false,
      drift: [],
    })
    assert.equal(commandCalls, 0)
    assert.equal(openCalls, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ensurePlayerFacingSynced checkOnly reports drift without triggering Obsidian", async () => {
  let commandCalls = 0
  let openCalls = 0

  const result = await ensurePlayerFacingSynced({
    checkOnly: true,
    checkDrift: () => ['z_player_facing/Lore.md: out of date with "Lore.md"'],
    runObsidianCommand: () => {
      commandCalls++
      return { ok: true, status: 0, stderr: "" }
    },
    openVaultInObsidian: () => {
      openCalls++
    },
  })

  assert.deepEqual(result, {
    status: "stale",
    attempts: 1,
    triggered: false,
    launchedObsidian: false,
    drift: ['z_player_facing/Lore.md: out of date with "Lore.md"'],
  })
  assert.equal(commandCalls, 0)
  assert.equal(openCalls, 0)
})

test("ensurePlayerFacingSynced triggers running Obsidian CLI and polls until drift clears", async () => {
  let pollCount = 0
  let currentTime = 0
  const commands = []
  let openCalls = 0

  const result = await ensurePlayerFacingSynced({
    vaultName: "Timescape",
    timeoutMs: 2_000,
    pollIntervalMs: 100,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms
    },
    checkDrift: () => {
      pollCount++
      return pollCount >= 3 ? [] : ['z_player_facing/Lore.md: out of date with "Lore.md"']
    },
    runObsidianCommand: (args) => {
      commands.push(args)
      return { ok: true, status: 0, stderr: "" }
    },
    openVaultInObsidian: () => {
      openCalls++
    },
  })

  assert.deepEqual(result, {
    status: "synced",
    attempts: 3,
    triggered: true,
    launchedObsidian: false,
    drift: [],
  })
  assert.deepEqual(commands, [{ vaultName: "Timescape", commandId: DEFAULT_PFN_COMMAND_ID }])
  assert.equal(openCalls, 0)
})

test("ensurePlayerFacingSynced launches Obsidian when closed and retries command after boot", async () => {
  const root = mkdtempSync(join(tmpdir(), "timescape-pfn-closed-"))
  const vault = join(root, "CampaignVault")
  mkdirSync(join(vault, "z_player_facing"), { recursive: true })
  try {
    writeFixtureFile(vault, "Capital.md", "::pf\nUpdated city lore\n::/pf\n")
    writeFixtureFile(
      vault,
      "z_player_facing/Capital.md",
      '---\npublish: true\npfn-source: "Capital.md"\n---\nOld city lore\n',
    )

    let currentTime = 0
    const openedVaults = []
    const triggerCalls = []

    const result = await ensurePlayerFacingSynced({
      vaultDirectory: vault,
      timeoutMs: 25_000,
      pollIntervalMs: 500,
      retryTriggerAfterMs: 2_500,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms
      },
      openVaultInObsidian: (name) => {
        openedVaults.push(name)
      },
      runObsidianCommand: ({ vaultName, commandId }) => {
        triggerCalls.push({ at: currentTime, vaultName, commandId })
        if (triggerCalls.length < 4) {
          return { ok: false, status: 1, stderr: "Obsidian is still starting" }
        }
        // Succeeds on the 4th attempt (at t = 7.5s) once Obsidian finishes loading plugins
        writeFixtureFile(
          vault,
          "z_player_facing/Capital.md",
          '---\npublish: true\npfn-source: "Capital.md"\n---\nUpdated city lore\n',
        )
        return { ok: true, status: 0, stderr: "" }
      },
    })

    assert.equal(result.status, "synced")
    assert.equal(result.triggered, true)
    assert.equal(result.launchedObsidian, true)
    assert.deepEqual(result.drift, [])
    assert.deepEqual(openedVaults, ["CampaignVault"])
    assert.equal(triggerCalls.length, 4)
    assert.deepEqual(
      triggerCalls.map((c) => c.at),
      [0, 2_500, 5_000, 7_500],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ensurePlayerFacingSynced returns stale with drift entries when timeout expires", async () => {
  let currentTime = 0
  let commandCalls = 0
  const expectedDrift = [
    "Campaigns/Prologue.md: has player-facing content not exported to z_player_facing/",
  ]

  const result = await ensurePlayerFacingSynced({
    timeoutMs: 1_000,
    pollIntervalMs: 300,
    retryTriggerAfterMs: 500,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms
    },
    checkDrift: () => expectedDrift,
    runObsidianCommand: () => {
      commandCalls++
      return { ok: true, status: 0, stderr: "" }
    },
    openVaultInObsidian: () => {},
  })

  assert.equal(result.status, "stale")
  assert.equal(result.triggered, true)
  assert.equal(result.launchedObsidian, false)
  assert.deepEqual(result.drift, expectedDrift)
  assert.equal(commandCalls, 2)
})

test("resolveObsidianCliCandidates includes OBSIDIAN_CLI and standard Windows install paths", () => {
  const winCandidates = resolveObsidianCliCandidates(
    {
      OBSIDIAN_CLI: "D:\\Tools\\Obsidian\\Obsidian.com",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
    },
    "win32",
  )

  assert.deepEqual(winCandidates, [
    "D:\\Tools\\Obsidian\\Obsidian.com",
    "obsidian",
    "obsidian.com",
    "C:\\Users\\tester\\AppData\\Local\\Programs\\Obsidian\\Obsidian.com",
    "C:\\Users\\tester\\AppData\\Local\\Obsidian\\Obsidian.com",
    "C:\\Program Files\\Obsidian\\Obsidian.com",
  ])

  const linuxCandidates = resolveObsidianCliCandidates({}, "linux")
  assert.deepEqual(linuxCandidates, ["obsidian"])
})

test("ensurePlayerFacingSynced surfaces lastCommandError when CLI fails through timeout", async () => {
  let currentTime = 0
  const result = await ensurePlayerFacingSynced({
    timeoutMs: 1_000,
    pollIntervalMs: 500,
    retryTriggerAfterMs: 500,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms
    },
    checkDrift: () => ['z_player_facing/The Cauldron.md: out of date with "The Cauldron.md"'],
    runObsidianCommand: () => ({
      ok: false,
      status: null,
      stderr: "",
      error: "Obsidian CLI not found on PATH",
    }),
    openVaultInObsidian: () => {},
  })

  assert.equal(result.status, "stale")
  assert.equal(result.launchedObsidian, true)
  assert.equal(result.lastCommandError, "Obsidian CLI not found on PATH")
})
