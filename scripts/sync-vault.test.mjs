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
import {
  extractAssetReferences,
  extractPlayerFacingContent,
  normalizeReference,
  syncVault,
} from "./sync-vault.mjs"

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

test("extractPlayerFacingContent extracts ::pf blocks, zoommap fences, unclosed markers, and pfn whole notes", () => {
  const mixedMarkdown = [
    "---",
    "secret_dc: 18",
    "---",
    "Private GM intro.",
    "",
    "::pf",
    "First public paragraph.",
    "",
    "```zoommap",
    "imageBases:",
    "  - path: z_Assets/Vasloria_Map.jpg",
    "```",
    "::/pf",
    "",
    "Private GM middle section.",
    "```markdown",
    "::pf",
    "Fake marker inside code block",
    "::/pf",
    "```",
    "",
    "::pf",
    "Unclosed public ending.",
  ].join("\n")

  const extracted = extractPlayerFacingContent(mixedMarkdown)
  assert.equal(extracted.hasPlayerFacing, true)
  assert.equal(extracted.isWholeNote, false)
  assert.equal(extracted.hasMarkers, true)
  assert.match(extracted.body, /First public paragraph\./)
  assert.match(extracted.body, /z_Assets\/Vasloria_Map\.jpg/)
  assert.match(extracted.body, /Unclosed public ending\./)
  assert.doesNotMatch(extracted.body, /Private GM/)
  assert.doesNotMatch(extracted.body, /Fake marker inside code block/)

  const wholeNote = extractPlayerFacingContent("---\npfn: true\n---\n\nFull public map note\n")
  assert.equal(wholeNote.hasPlayerFacing, true)
  assert.equal(wholeNote.isWholeNote, true)
  assert.equal(wholeNote.body, "Full public map note")

  const falseWhole = extractPlayerFacingContent("---\npfn: false\n---\n\nOnly GM notes\n")
  assert.equal(falseWhole.hasPlayerFacing, false)

  const emptyTemplate = extractPlayerFacingContent("---\ntags: [template]\n---\n\n::pf\n\n::/pf\n")
  assert.equal(emptyTemplate.hasPlayerFacing, false)
})

test("syncVault passes with zero drift when exports match despite GM-only edits and unwrapped wikilinks", () => {
  const { root, vault, content, fallbackIndex } = createFixtureWorkspace()
  try {
    writeFixtureFile(
      vault,
      "Campaigns/Prologue.md",
      [
        "---",
        "gm_notes: ambush planned",
        "---",
        "GM secret prep section updated later.",
        "",
        "::pf",
        "**[[House Vorona]]** guards [[Secret GM Note|the Baron]] cleanly.",
        "::/pf",
      ].join("\n"),
    )
    writeFixtureFile(
      vault,
      "z_player_facing/Campaigns/Prologue.md",
      [
        "---",
        "publish: true",
        'pfn-source: "Campaigns/Prologue.md"',
        "tags: [lore]",
        "aliases: [Intro]",
        "---",
        "",
        "**House Vorona** guards the Baron cleanly.",
      ].join("\n"),
    )

    writeFixtureFile(
      vault,
      "Atlas/Vasloria.md",
      [
        "---",
        "pfn: true",
        "---",
        "```zoommap",
        "imageBases:",
        "  - path: z_Assets/Vasloria_Map.jpg",
        "```",
      ].join("\n"),
    )
    writeFixtureFile(
      vault,
      "z_player_facing/Atlas/Vasloria.md",
      [
        "---",
        "publish: true",
        'pfn-source: "Atlas/Vasloria.md"',
        "---",
        "```zoommap",
        "imageBases:",
        "  - path: z_Assets/Vasloria_Map.jpg",
        "```",
      ].join("\n"),
    )
    writeFixtureFile(vault, "z_Assets/Vasloria_Map.jpg", "jpg-bytes")

    const initialResult = syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })
    assert.deepEqual(initialResult.playerFacingDrift, [])

    // Edit strictly GM-only content outside ::pf in Campaigns/Prologue.md
    writeFixtureFile(
      vault,
      "Campaigns/Prologue.md",
      [
        "---",
        "gm_notes: revised secret trap",
        "---",
        "Completely rewritten GM secret prep.",
        "",
        "::pf",
        "**[[House Vorona]]** guards [[Secret GM Note|the Baron]] cleanly.",
        "::/pf",
      ].join("\n"),
    )

    const afterGmEdit = syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })
    assert.deepEqual(afterGmEdit.playerFacingDrift, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("syncVault detects stale, unexported, orphaned, and emptied player-facing exports without leaking secrets", () => {
  const { root, vault, content, fallbackIndex } = createFixtureWorkspace()
  try {
    // 1. Edited ::pf block (out of date)
    writeFixtureFile(
      vault,
      "Campaigns/Prologue.md",
      [
        "PRIVATE SECRET PHRASE DO NOT LEAK",
        "::pf",
        "Updated public recap text NEW_PUBLIC_LINE.",
        "::/pf",
      ].join("\n"),
    )
    writeFixtureFile(
      vault,
      "z_player_facing/Campaigns/Prologue.md",
      [
        "---",
        "publish: true",
        'pfn-source: "Campaigns/Prologue.md"',
        "---",
        "Old exported recap text.",
      ].join("\n"),
    )

    // 2. Unexported source note with player-facing content
    writeFixtureFile(
      vault,
      "Campaigns/NewHandout.md",
      ["---", "pfn: true", "---", "UNEXPORTED_HANDOUT_BODY_TOKEN"].join("\n"),
    )

    // 3. Exported file whose pfn-source was deleted
    writeFixtureFile(
      vault,
      "z_player_facing/Campaigns/DeletedSource.md",
      [
        "---",
        "publish: true",
        'pfn-source: "Campaigns/DeletedSource.md"',
        "---",
        "Orphaned exported copy.",
      ].join("\n"),
    )

    // 4. Exported file whose source no longer has player-facing content
    writeFixtureFile(
      vault,
      "Campaigns/Retracted.md",
      ["---", "pfn: false", "---", "SECRET_RETRACTED_BODY_TOKEN"].join("\n"),
    )
    writeFixtureFile(
      vault,
      "z_player_facing/Campaigns/Retracted.md",
      [
        "---",
        "publish: true",
        'pfn-source: "Campaigns/Retracted.md"',
        "---",
        "Previously published text.",
      ].join("\n"),
    )

    const result = syncVault({
      vaultDirectory: vault,
      contentDirectory: content,
      fallbackIndexPath: fallbackIndex,
    })

    assert.equal(result.playerFacingDrift.length, 4)
    assert.ok(
      result.playerFacingDrift.some((issue) =>
        issue.includes(
          'z_player_facing/Campaigns/Prologue.md: out of date with "Campaigns/Prologue.md"',
        ),
      ),
    )
    assert.ok(
      result.playerFacingDrift.some((issue) =>
        issue.includes(
          "Campaigns/NewHandout.md: has player-facing content not exported to z_player_facing/",
        ),
      ),
    )
    assert.ok(
      result.playerFacingDrift.some((issue) =>
        issue.includes(
          'z_player_facing/Campaigns/DeletedSource.md: references missing pfn-source "Campaigns/DeletedSource.md"',
        ),
      ),
    )
    assert.ok(
      result.playerFacingDrift.some((issue) =>
        issue.includes(
          'z_player_facing/Campaigns/Retracted.md: stale export because "Campaigns/Retracted.md" no longer has player-facing content',
        ),
      ),
    )

    const combinedOutput = result.playerFacingDrift.join("\n")
    assert.doesNotMatch(combinedOutput, /PRIVATE SECRET PHRASE DO NOT LEAK/)
    assert.doesNotMatch(combinedOutput, /NEW_PUBLIC_LINE/)
    assert.doesNotMatch(combinedOutput, /UNEXPORTED_HANDOUT_BODY_TOKEN/)
    assert.doesNotMatch(combinedOutput, /SECRET_RETRACTED_BODY_TOKEN/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
