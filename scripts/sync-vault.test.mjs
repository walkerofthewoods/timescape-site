import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { extractAssetReferences, normalizeReference, syncVault } from "./sync-vault.mjs"

function writeFixtureFile(root, relPath, content = "") {
  const fullPath = join(root, ...relPath.split("/"))
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, "utf8")
  return fullPath
}

function createFixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "timescape-sync-test-"))
  const vault = join(root, "vault")
  const content = join(root, "content")
  const fallbackIndex = join(root, "overrides", "index.md")
  mkdirSync(join(vault, "z_player_facing"), { recursive: true })
  mkdirSync(join(vault, "z_Assets"), { recursive: true })
  writeFixtureFile(root, "overrides/index.md", "---\ntitle: The Timescape\npublish: true\n---\n")
  return { root, vault, content, fallbackIndex }
}

test("normalizeReference handles POSIX slashes, aliases, fragments, titles, and external URLs", () => {
  assert.equal(
    normalizeReference("  ./z_Assets\\Omund's Land.png#top|400  "),
    "z_Assets/Omund's Land.png",
  )
  assert.equal(normalizeReference('<z_Assets/Urland%20Map.jpg> "Map"'), "z_Assets/Urland Map.jpg")
  assert.equal(normalizeReference("z_Assets/world.png 'Title'"), "z_Assets/world.png")
  assert.equal(normalizeReference("../GM_Secrets/dungeon.png"), "../GM_Secrets/dungeon.png")
  assert.equal(normalizeReference("https://example.com/map.png"), null)
  assert.equal(normalizeReference("mailto:gm@example.com"), null)
  assert.equal(normalizeReference("#section-heading"), null)
  assert.equal(normalizeReference("   "), null)
})

test("extractAssetReferences ignores non-zoommap code blocks, external images, and note wikilinks", () => {
  const markdown = [
    "# Journal",
    "See [[Session 1.5.md]] and [[Dr. Vorona]] and ![[GM Secret.md]] and ![[GM Secret]].",
    "External: ![World](https://example.com/world.png)",
    "Local: ![Crest](z_Assets/crest.png) and ![[banner.webp|300]]",
    "",
    "```markdown",
    "![Fake](z_Assets/never-copy.png)",
    "![[fake-in-code.png]]",
    "```",
    "",
    "```zoommap",
    "imageBases:",
    "  - path: z_Assets/Vasloria_Map.jpg",
    "markers: z_Assets/Vasloria_Map.markers.json",
    "```",
  ].join("\n")

  const refs = extractAssetReferences(markdown)
  assert.deepEqual(refs.assetRefs.sort(), [
    "banner.webp",
    "z_Assets/Vasloria_Map.jpg",
    "z_Assets/crest.png",
  ])
  assert.deepEqual(refs.markerRefs, ["z_Assets/Vasloria_Map.markers.json"])
})

test("syncVault copies player-facing pages, referenced assets, and marker sidecar dependencies", () => {
  const { root, vault, content, fallbackIndex } = createFixtureWorkspace()
  try {
    writeFixtureFile(
      vault,
      "z_player_facing/Atlas/Vasloria.md",
      [
        "---",
        "publish: true",
        "---",
        "![[world-banner.png|500]]",
        "```zoommap",
        "imageBases:",
        "  - path: z_Assets/Vasloria_Map.jpg",
        "```",
      ].join("\n"),
    )
    writeFixtureFile(vault, "z_Assets/Vasloria_Map.jpg", "jpg-bytes")
    writeFixtureFile(
      vault,
      "z_Assets/Vasloria_Map.jpg.markers.json",
      JSON.stringify({
        overlays: [{ path: "z_Assets/RoadsOverlay.png" }],
        markers: [{ stickerPath: "z_Assets/CapitalPin.svg" }],
      }),
    )
    writeFixtureFile(vault, "z_Assets/RoadsOverlay.png", "overlay-bytes")
    writeFixtureFile(vault, "z_Assets/CapitalPin.svg", "svg-bytes")
    writeFixtureFile(vault, "z_Assets/world-banner.png", "banner-bytes")
    writeFixtureFile(vault, "z_Assets/unused.png", "unused-bytes")

    const result = syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })

    assert.equal(result.copiedPages, 2)
    assert.equal(result.copiedAssets, 5)
    assert.deepEqual(result.missingReferences, [])
    assert.deepEqual(result.disallowedReferences, [])
    assert.ok(existsSync(join(content, "index.md")))
    assert.ok(existsSync(join(content, "Atlas/Vasloria.md")))
    assert.ok(existsSync(join(content, "z_Assets/Vasloria_Map.jpg")))
    assert.ok(existsSync(join(content, "z_Assets/Vasloria_Map.jpg.markers.json")))
    assert.ok(existsSync(join(content, "z_Assets/RoadsOverlay.png")))
    assert.ok(existsSync(join(content, "z_Assets/CapitalPin.svg")))
    assert.ok(existsSync(join(content, "z_Assets/world-banner.png")))
    assert.ok(!existsSync(join(content, "z_Assets/unused.png")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("syncVault blocks GM markdown spoilers, outside asset folders, path traversal, and .obsidian files", () => {
  const { root, vault, content, fallbackIndex } = createFixtureWorkspace()
  try {
    writeFixtureFile(vault, "GM_Notes/Secret Plot.md", "# BBEG Secret")
    writeFixtureFile(vault, "GM_Notes/dungeon.png", "secret-map")
    writeFixtureFile(vault, ".obsidian/app.json", "{}")
    writeFixtureFile(
      vault,
      "z_player_facing/Session 1.md",
      [
        "---",
        "publish: true",
        "---",
        "![[Secret Plot.md]]",
        "![[Secret Plot]]",
        "[[Session 1.5.md]]",
        "![[GM_Notes/dungeon.png]]",
        "![Secret](../GM_Notes/dungeon.png)",
        "![Config](.obsidian/app.json)",
      ].join("\n"),
    )

    const result = syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })

    assert.ok(!existsSync(join(content, "GM_Notes")))
    assert.ok(!existsSync(join(content, ".obsidian")))
    assert.deepEqual(result.missingReferences, [])
    assert.deepEqual(result.disallowedReferences, [
      "../GM_Notes/dungeon.png",
      ".obsidian/app.json",
      "GM_Notes/dungeon.png",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("syncVault preserves vault index.md when present and cleans stale synced files", () => {
  const { root, vault, content, fallbackIndex } = createFixtureWorkspace()
  try {
    writeFixtureFile(content, "StaleNote.md", "old content")
    writeFixtureFile(
      vault,
      "z_player_facing/index.md",
      "---\ntitle: Vault Home\npublish: true\n---\n",
    )
    writeFixtureFile(vault, "z_player_facing/LiveNote.md", "live content")

    const result = syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })

    assert.equal(result.copiedPages, 2)
    assert.ok(!existsSync(join(content, "StaleNote.md")))
    assert.match(readFileSync(join(content, "index.md"), "utf8"), /Vault Home/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("syncVault reconciles files in place without rewriting unchanged files or deleting content root", () => {
  const { root, vault, content, fallbackIndex } = createFixtureWorkspace()
  try {
    writeFixtureFile(vault, "z_player_facing/Unchanged.md", "same")
    writeFixtureFile(vault, "z_player_facing/Modified.md", "v1")
    writeFixtureFile(vault, "z_player_facing/OldDir/Removed.md", "gone")

    syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })

    const past = new Date(Date.now() - 60_000)
    const unchangedDest = join(content, "Unchanged.md")
    const modifiedDest = join(content, "Modified.md")
    utimesSync(unchangedDest, past, past)
    utimesSync(modifiedDest, past, past)
    const unchangedMtimeBefore = statSync(unchangedDest).mtimeMs
    const modifiedMtimeBefore = statSync(modifiedDest).mtimeMs

    writeFixtureFile(vault, "z_player_facing/Modified.md", "v2")
    rmSync(join(vault, "z_player_facing/OldDir/Removed.md"))

    const result = syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })

    assert.equal(result.copiedPages, 3)
    assert.equal(statSync(unchangedDest).mtimeMs, unchangedMtimeBefore)
    assert.notEqual(statSync(modifiedDest).mtimeMs, modifiedMtimeBefore)
    assert.equal(readFileSync(modifiedDest, "utf8"), "v2")
    assert.ok(!existsSync(join(content, "OldDir")))
    assert.ok(existsSync(content))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
