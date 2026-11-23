import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse as parseYaml } from "yaml"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const siteDirectory = resolve(scriptDirectory, "..")

export const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".bmp",
  ".pdf",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".mp4",
  ".webm",
])

export const DEFAULT_PLAYER_FACING_DIR = "z_player_facing"
export const DEFAULT_ALLOWED_ASSET_DIRS = ["z_Assets"]
const DEFAULT_PFN_OPEN_MARKER = "::pf"
const DEFAULT_PFN_CLOSE_MARKER = "::/pf"
const DEFAULT_PFN_WHOLE_NOTE_PROPERTY = "pfn"

function splitFrontmatter(markdown) {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  if (normalized === "---" || normalized.startsWith("---\n---")) {
    const rest = normalized.startsWith("---\n---\n") ? normalized.slice(8) : ""
    return { frontmatter: {}, body: rest }
  }

  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) return { frontmatter: null, body: normalized }

  try {
    const parsed = parseYaml(match[1])
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
    return { frontmatter, body: normalized.slice(match[0].length) }
  } catch {
    return { frontmatter: null, body: normalized }
  }
}

function loadPfnPluginConfig(vaultDirectory) {
  const defaults = {
    openMarker: DEFAULT_PFN_OPEN_MARKER,
    closeMarker: DEFAULT_PFN_CLOSE_MARKER,
    wholeNoteProperty: DEFAULT_PFN_WHOLE_NOTE_PROPERTY,
    excludedFolders: [],
  }

  const configPath = join(
    vaultDirectory,
    ".obsidian",
    "plugins",
    "player-facing-notes",
    "data.json",
  )
  if (!existsSync(configPath)) return defaults

  try {
    if (!statSync(configPath).isFile()) return defaults
    const parsed = JSON.parse(readFileSync(configPath, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults

    const pickString = (candidates, fallback) => {
      for (const value of candidates) {
        if (typeof value === "string" && value.trim().length > 0) return value.trim()
      }
      return fallback
    }

    const rawExcluded = Array.isArray(parsed.excludedFolders)
      ? parsed.excludedFolders
      : Array.isArray(parsed.ignoreFolders)
        ? parsed.ignoreFolders
        : []

    const excludedFolders = rawExcluded
      .filter((entry) => typeof entry === "string")
      .map((entry) =>
        entry
          .trim()
          .replaceAll("\\", "/")
          .replace(/^(?:\.\/|\/)+|\/+$/g, ""),
      )
      .filter(Boolean)

    return {
      openMarker: pickString([parsed.openMarker, parsed.startMarker], defaults.openMarker),
      closeMarker: pickString([parsed.closeMarker, parsed.endMarker], defaults.closeMarker),
      wholeNoteProperty: pickString(
        [parsed.wholeNoteProperty, parsed.frontmatterProperty],
        defaults.wholeNoteProperty,
      ),
      excludedFolders,
    }
  } catch {
    return defaults
  }
}

export function extractPlayerFacingContent(sourceMarkdown, options = {}) {
  const openMarker = options.openMarker ?? DEFAULT_PFN_OPEN_MARKER
  const closeMarker = options.closeMarker ?? DEFAULT_PFN_CLOSE_MARKER
  const wholeNoteProperty = options.wholeNoteProperty ?? DEFAULT_PFN_WHOLE_NOTE_PROPERTY

  const { frontmatter, body } = splitFrontmatter(sourceMarkdown)
  const rawFlag = frontmatter?.[wholeNoteProperty]
  const isWholeNote =
    rawFlag === true || (typeof rawFlag === "string" && rawFlag.trim().toLowerCase() === "true")

  const lines = body.split("\n")
  let activeFence = null
  let inPf = false
  let hasMarkers = false
  let currentBlock = []
  const blocks = []
  const wholeNoteLines = []

  for (const line of lines) {
    if (activeFence) {
      const closePattern = new RegExp(`^\\s*${activeFence.char}{${activeFence.length},}\\s*$`)
      if (closePattern.test(line)) {
        activeFence = null
      }
      if (isWholeNote) {
        wholeNoteLines.push(line)
      } else if (inPf) {
        currentBlock.push(line)
      }
      continue
    }

    const trimmed = line.trim()
    if (trimmed === openMarker) {
      hasMarkers = true
      if (!inPf) {
        inPf = true
        currentBlock = []
      }
      continue
    }

    if (trimmed === closeMarker) {
      if (inPf) {
        inPf = false
        blocks.push(currentBlock.join("\n"))
        currentBlock = []
      }
      continue
    }

    const openMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (openMatch) {
      const fence = openMatch[1]
      activeFence = {
        char: fence[0],
        length: fence.length,
      }
    }

    if (isWholeNote) {
      wholeNoteLines.push(line)
    } else if (inPf) {
      currentBlock.push(line)
    }
  }

  if (inPf && currentBlock.length > 0) {
    blocks.push(currentBlock.join("\n"))
  }

  const nonEmptyBlocks = blocks.map((block) => block.trim()).filter((block) => block.length > 0)
  const hasPlayerFacing = isWholeNote || (hasMarkers && nonEmptyBlocks.length > 0)
  const extractedBody = isWholeNote ? wholeNoteLines.join("\n").trim() : nonEmptyBlocks.join("\n\n")

  return {
    hasPlayerFacing,
    isWholeNote,
    hasMarkers,
    body: extractedBody,
  }
}

function normalizeComparableBody(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function unwrapWikilinks(text) {
  return text.replace(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => {
    const label = alias ?? target.split("#")[0].split("/").pop() ?? ""
    return label.trim()
  })
}

function playerFacingBodiesMatch(expectedBody, exportedBody) {
  if (normalizeComparableBody(expectedBody) === normalizeComparableBody(exportedBody)) {
    return true
  }
  return (
    normalizeComparableBody(unwrapWikilinks(expectedBody)) ===
    normalizeComparableBody(unwrapWikilinks(exportedBody))
  )
}

export function checkPlayerFacingSync({
  vaultDirectory,
  playerFacingDirectory,
  playerFacingDirName = DEFAULT_PLAYER_FACING_DIR,
  allowedAssetDirPaths = [],
}) {
  const pluginConfig = loadPfnPluginConfig(vaultDirectory)
  const driftIssues = []
  const exportedBySource = new Map()

  const exportedMarkdownFiles = walkFiles(playerFacingDirectory).filter(
    (file) => posix.extname(file.toLowerCase()) === ".md",
  )

  for (const exportedFile of exportedMarkdownFiles) {
    const exportedRel = relative(vaultDirectory, exportedFile).replaceAll("\\", "/")
    const { frontmatter, body: exportedBody } = splitFrontmatter(readFileSync(exportedFile, "utf8"))
    const rawSource = frontmatter?.["pfn-source"]
    if (typeof rawSource !== "string" || rawSource.trim().length === 0) continue

    const sourceRel = rawSource
      .trim()
      .replaceAll("\\", "/")
      .replace(/^(?:\.\/|\/)+/, "")
      .replace(/\/{2,}/g, "/")
    const sourcePath = resolve(vaultDirectory, ...sourceRel.split("/"))

    if (
      !sourceRel ||
      hasDotSegment(sourceRel) ||
      !isWithinDirectory(sourcePath, vaultDirectory) ||
      !existsSync(sourcePath) ||
      !statSync(sourcePath).isFile()
    ) {
      driftIssues.push(`${exportedRel}: references missing pfn-source "${sourceRel}"`)
      continue
    }

    exportedBySource.set(sourceRel, exportedRel)
    const extracted = extractPlayerFacingContent(readFileSync(sourcePath, "utf8"), pluginConfig)

    if (!extracted.hasPlayerFacing) {
      driftIssues.push(
        `${exportedRel}: stale export because "${sourceRel}" no longer has player-facing content`,
      )
    } else if (!playerFacingBodiesMatch(extracted.body, exportedBody)) {
      driftIssues.push(`${exportedRel}: out of date with "${sourceRel}"`)
    }
  }

  const vaultMarkdownFiles = walkFiles(vaultDirectory).filter(
    (file) => posix.extname(file.toLowerCase()) === ".md",
  )

  for (const sourceFile of vaultMarkdownFiles) {
    if (
      isWithinDirectory(sourceFile, playerFacingDirectory) ||
      allowedAssetDirPaths.some((dir) => isWithinDirectory(sourceFile, dir))
    ) {
      continue
    }

    const sourceRel = relative(vaultDirectory, sourceFile).replaceAll("\\", "/")
    if (
      pluginConfig.excludedFolders.some(
        (folder) => sourceRel === folder || sourceRel.startsWith(`${folder}/`),
      )
    ) {
      continue
    }

    if (exportedBySource.has(sourceRel)) continue

    const extracted = extractPlayerFacingContent(readFileSync(sourceFile, "utf8"), pluginConfig)
    if (extracted.hasPlayerFacing) {
      driftIssues.push(
        `${sourceRel}: has player-facing content not exported to ${playerFacingDirName}/`,
      )
    }
  }

  return driftIssues.sort()
}

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

function hasDotSegment(posixPath) {
  return posixPath
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")
}

export function isAllowedAssetFile(filePath) {
  const normalized = filePath.replaceAll("\\", "/")
  if (hasDotSegment(normalized)) return false
  const lower = normalized.toLowerCase()
  if (lower.endsWith(".markers.json")) return true
  return ALLOWED_ASSET_EXTENSIONS.has(posix.extname(lower))
}

export function normalizeReference(raw) {
  if (typeof raw !== "string") return null
  let ref = raw.trim()
  if (!ref) return null

  if (ref.startsWith("<")) {
    const closeIdx = ref.indexOf(">")
    ref = closeIdx !== -1 ? ref.slice(1, closeIdx).trim() : ref.slice(1).trim()
  } else {
    ref = ref.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "").trim()
  }

  if (!ref) return null
  if (/^(?:[a-z][a-z0-9+.-]+:|\/\/|#)/i.test(ref)) return null

  ref = ref.split("#")[0].split("|")[0].trim()
  if (!ref) return null

  try {
    ref = decodeURIComponent(ref)
  } catch {
    // Preserve literal string when percent-encoding is malformed
  }

  ref = ref.replaceAll("\\", "/")
  ref = ref.replace(/^(?:\.\/|\/)+/, "")
  ref = ref.replace(/\/{2,}/g, "/")

  return ref || null
}

function parseMarkdownBlocks(sourceMarkdown) {
  const lines = sourceMarkdown.split(/\r?\n/)
  const markdownLines = []
  const zoommapBlocks = []
  let activeFence = null

  for (const line of lines) {
    if (activeFence) {
      const closePattern = new RegExp(`^\\s*${activeFence.char}{${activeFence.length},}\\s*$`)
      if (closePattern.test(line)) {
        if (activeFence.lang === "zoommap") {
          zoommapBlocks.push(activeFence.lines.join("\n"))
        }
        activeFence = null
      } else if (activeFence.lang === "zoommap") {
        activeFence.lines.push(line)
      }
      continue
    }

    const openMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (openMatch) {
      const fence = openMatch[1]
      const info = openMatch[2].trim()
      const lang = info.split(/\s+/)[0]?.toLowerCase() ?? ""
      activeFence = {
        char: fence[0],
        length: fence.length,
        lang,
        lines: [],
      }
      continue
    }

    markdownLines.push(line)
  }

  if (activeFence?.lang === "zoommap") {
    zoommapBlocks.push(activeFence.lines.join("\n"))
  }

  return {
    strippedMarkdown: markdownLines.join("\n"),
    zoommapBlocks,
  }
}

function extractMarkerDataAssetRefs(data) {
  const refs = []
  if (!data || typeof data !== "object") return refs

  if (Array.isArray(data.bases)) {
    for (const base of data.bases) {
      const path = typeof base === "string" ? base : base?.path
      const normalized = normalizeReference(path)
      if (normalized) refs.push(normalized)
    }
  }

  if (Array.isArray(data.overlays)) {
    for (const overlay of data.overlays) {
      const path = typeof overlay === "string" ? overlay : overlay?.path
      const normalized = normalizeReference(path)
      if (normalized) refs.push(normalized)
    }
  }

  if (Array.isArray(data.markers)) {
    for (const marker of data.markers) {
      const normalized = normalizeReference(marker?.stickerPath)
      if (normalized) refs.push(normalized)
    }
  }

  return refs
}

function extractInlineZoommapData(sourceMarkdown, mapId) {
  if (!mapId) return []
  const header = `ZOOMMAP-DATA id=${mapId}`
  const footer = "/ZOOMMAP-DATA"
  const headerIdx = sourceMarkdown.indexOf(header)
  if (headerIdx < 0) return []
  const lineEnd = sourceMarkdown.indexOf("\n", headerIdx)
  if (lineEnd < 0) return []
  const footerIdx = sourceMarkdown.indexOf(footer, lineEnd + 1)
  if (footerIdx < 0) return []
  const rawJson = sourceMarkdown.slice(lineEnd + 1, footerIdx).trim()
  if (!rawJson) return []

  try {
    return extractMarkerDataAssetRefs(JSON.parse(rawJson))
  } catch {
    return []
  }
}

export function extractAssetReferences(sourceMarkdown) {
  const assetRefs = new Set()
  const markerRefs = new Set()

  const addRef = (raw, forceMarker = false) => {
    const normalized = normalizeReference(raw)
    if (!normalized) return
    if (forceMarker || normalized.toLowerCase().endsWith(".markers.json")) {
      markerRefs.add(normalized)
    } else {
      assetRefs.add(normalized)
    }
  }

  const { strippedMarkdown, zoommapBlocks } = parseMarkdownBlocks(sourceMarkdown)
  const cleanMarkdown = strippedMarkdown.replace(/`[^`\n]+`/g, "")

  for (const match of cleanMarkdown.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    const normalized = normalizeReference(match[1])
    if (!normalized) continue
    // Only treat wikilinks as asset references when they point to an allowed asset type;
    // note links like [[GM Secret]], [[GM Secret.md]], or [[Session 1.5.md]] must stay note links.
    if (isAllowedAssetFile(normalized)) {
      addRef(normalized)
    }
  }

  for (const match of cleanMarkdown.matchAll(
    /!\[[^\]]*\]\((<[^>]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g,
  )) {
    addRef(match[1])
  }

  for (const block of zoommapBlocks) {
    let parsed
    try {
      parsed = parseYaml(block)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object") continue

    let primaryImage = null
    if (Array.isArray(parsed.imageBases)) {
      for (const base of parsed.imageBases) {
        const path = typeof base === "string" ? base : base?.path
        const normalized = normalizeReference(path)
        if (normalized) {
          if (!primaryImage) primaryImage = normalized
          assetRefs.add(normalized)
        }
      }
    }

    if (typeof parsed.image === "string") {
      const normalized = normalizeReference(parsed.image)
      if (normalized) {
        if (!primaryImage) primaryImage = normalized
        assetRefs.add(normalized)
      }
    }

    if (Array.isArray(parsed.imageOverlays)) {
      for (const overlay of parsed.imageOverlays) {
        const path = typeof overlay === "string" ? overlay : overlay?.path
        addRef(path)
      }
    }

    if (parsed.storage === "note") {
      if (typeof parsed.id === "string") {
        for (const ref of extractInlineZoommapData(sourceMarkdown, parsed.id)) {
          assetRefs.add(ref)
        }
      }
    } else if (typeof parsed.markers === "string") {
      addRef(parsed.markers, true)
    } else if (primaryImage) {
      addRef(`${primaryImage}.markers.json`, true)
    }
  }

  return {
    assetRefs: [...assetRefs],
    markerRefs: [...markerRefs],
  }
}

function walkFiles(directory, { skipDotDirectories = true } = {}) {
  if (!existsSync(directory)) return []

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipDotDirectories && entry.name.startsWith(".")) return []
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) return walkFiles(entryPath, { skipDotDirectories })
    return entry.isFile() ? [entryPath] : []
  })
}

function isWithinDirectory(targetPath, directoryPath) {
  const rel = relative(resolve(directoryPath), resolve(targetPath))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function buildShortestPathIndex(directories) {
  const exactIndex = new Map()
  const lowerIndex = new Map()

  for (const directory of directories) {
    for (const filePath of walkFiles(directory)) {
      if (!isAllowedAssetFile(filePath)) continue
      const fileName = posix.basename(filePath.replaceAll("\\", "/"))
      if (!exactIndex.has(fileName)) exactIndex.set(fileName, filePath)
      const lower = fileName.toLowerCase()
      if (!lowerIndex.has(lower)) lowerIndex.set(lower, filePath)
    }
  }

  return { exactIndex, lowerIndex }
}

function resolveAssetPath(reference, sourceFile, context) {
  const { vaultDirectory, playerFacingDirectory, allowedAssetDirPaths, shortestPathIndex } = context
  const normalized = normalizeReference(reference)
  if (!normalized) return { status: "missing", reference }

  if (hasDotSegment(normalized) || !isAllowedAssetFile(normalized)) {
    return { status: "disallowed", reference: normalized }
  }

  const parts = normalized.split("/")
  const explicitCandidates = [
    resolve(dirname(sourceFile), ...parts),
    resolve(vaultDirectory, ...parts),
  ]

  const isAllowedPath = (absPath) => {
    if (!isWithinDirectory(absPath, vaultDirectory)) return false
    const relFromVault = relative(vaultDirectory, absPath).replaceAll("\\", "/")
    if (hasDotSegment(relFromVault)) return false
    if (!isAllowedAssetFile(absPath)) return false
    return (
      isWithinDirectory(absPath, playerFacingDirectory) ||
      allowedAssetDirPaths.some((dir) => isWithinDirectory(absPath, dir))
    )
  }

  for (const candidate of explicitCandidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return isAllowedPath(candidate)
        ? { status: "ok", path: candidate }
        : { status: "disallowed", reference: normalized }
    }
  }

  // Shortest-path resolution only applies to bare filenames within allowed directories
  if (!normalized.includes("/")) {
    const match =
      shortestPathIndex.exactIndex.get(normalized) ??
      shortestPathIndex.lowerIndex.get(normalized.toLowerCase())
    if (match) return { status: "ok", path: match }
  }

  // Flag explicit paths that traverse outside allowed vault directories even if missing
  if (explicitCandidates.some((candidate) => !isAllowedPath(candidate))) {
    return { status: "disallowed", reference: normalized }
  }

  return { status: "missing", reference: normalized }
}

function pruneEmptyDirectories(directory, rootDirectory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    pruneEmptyDirectories(join(directory, entry.name), rootDirectory)
  }
  if (resolve(directory) !== resolve(rootDirectory) && readdirSync(directory).length === 0) {
    rmdirSync(directory)
  }
}

export function syncVault({
  vaultDirectory,
  contentDirectory = join(siteDirectory, "content"),
  playerFacingDirName = DEFAULT_PLAYER_FACING_DIR,
  allowedAssetDirs = parseAllowedAssetDirs(process.env.TIMESCAPE_ASSET_DIRS),
  fallbackIndexPath = join(siteDirectory, "overrides", "index.md"),
} = {}) {
  if (!vaultDirectory) {
    throw new Error("Vault directory is required.")
  }

  const resolvedVault = resolve(vaultDirectory)
  if (!existsSync(resolvedVault) || !statSync(resolvedVault).isDirectory()) {
    throw new Error(`Vault directory not found: ${resolvedVault}`)
  }

  const playerFacingDirectory = resolve(resolvedVault, ...playerFacingDirName.split("/"))
  if (!existsSync(playerFacingDirectory) || !statSync(playerFacingDirectory).isDirectory()) {
    throw new Error(`Player-facing directory not found: ${playerFacingDirectory}`)
  }

  const resolvedContent = resolve(contentDirectory)
  const allowedAssetDirPaths = allowedAssetDirs.map((dir) =>
    resolve(resolvedVault, ...dir.replaceAll("\\", "/").split("/").filter(Boolean)),
  )

  const desiredFiles = new Map()
  for (const sourceFile of walkFiles(playerFacingDirectory)) {
    const relPosix = relative(playerFacingDirectory, sourceFile).replaceAll("\\", "/")
    desiredFiles.set(relPosix, sourceFile)
  }

  if (!desiredFiles.has("index.md") && fallbackIndexPath && existsSync(fallbackIndexPath)) {
    desiredFiles.set("index.md", resolve(fallbackIndexPath))
  }

  const shortestPathIndex = buildShortestPathIndex([playerFacingDirectory, ...allowedAssetDirPaths])
  const context = {
    vaultDirectory: resolvedVault,
    playerFacingDirectory,
    allowedAssetDirPaths,
    shortestPathIndex,
  }

  const markdownFiles = walkFiles(playerFacingDirectory).filter(
    (file) => posix.extname(file.toLowerCase()) === ".md",
  )

  const requiredAssets = new Set()
  const resolvedMarkers = new Map()
  const missingReferences = new Set()
  const disallowedReferences = new Set()

  const recordResolution = (resolution, isMarker = false) => {
    if (resolution.status === "ok") {
      requiredAssets.add(resolution.path)
      if (isMarker) resolvedMarkers.set(resolution.path, resolution.path)
    } else if (resolution.status === "disallowed") {
      disallowedReferences.add(resolution.reference)
    } else {
      missingReferences.add(resolution.reference)
    }
  }

  for (const markdownFile of markdownFiles) {
    const sourceMarkdown = readFileSync(markdownFile, "utf8")
    const { assetRefs, markerRefs } = extractAssetReferences(sourceMarkdown)

    for (const ref of assetRefs) {
      recordResolution(resolveAssetPath(ref, markdownFile, context), false)
    }

    for (const ref of markerRefs) {
      recordResolution(resolveAssetPath(ref, markdownFile, context), true)
    }
  }

  for (const markerFile of resolvedMarkers.keys()) {
    try {
      const markerData = JSON.parse(readFileSync(markerFile, "utf8"))
      for (const ref of extractMarkerDataAssetRefs(markerData)) {
        recordResolution(resolveAssetPath(ref, markerFile, context), false)
      }
    } catch {
      // Malformed marker JSON is reported by the Quartz build / map checks
    }
  }

  let copiedExtraAssets = 0
  for (const sourceAsset of requiredAssets) {
    if (isWithinDirectory(sourceAsset, playerFacingDirectory)) continue
    const relPosix = relative(resolvedVault, sourceAsset).replaceAll("\\", "/")
    desiredFiles.set(relPosix, sourceAsset)
    copiedExtraAssets++
  }

  mkdirSync(resolvedContent, { recursive: true })

  for (const [relPosix, sourcePath] of desiredFiles) {
    const destPath = join(resolvedContent, ...relPosix.split("/"))
    const sourceBytes = readFileSync(sourcePath)
    if (existsSync(destPath)) {
      if (statSync(destPath).isFile()) {
        if (readFileSync(destPath).equals(sourceBytes)) continue
      } else {
        rmSync(destPath, { recursive: true, force: true })
      }
    }
    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, sourceBytes)
  }

  for (const existingFile of walkFiles(resolvedContent, { skipDotDirectories: false })) {
    const relPosix = relative(resolvedContent, existingFile).replaceAll("\\", "/")
    if (!desiredFiles.has(relPosix)) {
      rmSync(existingFile, { force: true })
    }
  }

  pruneEmptyDirectories(resolvedContent, resolvedContent)

  const copiedPages = [...desiredFiles.keys()].filter(
    (relPath) => posix.extname(relPath.toLowerCase()) === ".md",
  ).length

  const playerFacingDrift = checkPlayerFacingSync({
    vaultDirectory: resolvedVault,
    playerFacingDirectory,
    playerFacingDirName,
    allowedAssetDirPaths,
  })

  return {
    copiedPages,
    copiedAssets: copiedExtraAssets,
    missingReferences: [...missingReferences].sort(),
    disallowedReferences: [...disallowedReferences].sort(),
    playerFacingDrift,
  }
}

function main() {
  const vaultArg = process.argv[2] ?? process.env.TIMESCAPE_VAULT
  if (!vaultArg || !vaultArg.trim()) {
    console.error(
      "Vault path is required. Pass it as an argument (`npm run sync:vault -- <path>`) or set TIMESCAPE_VAULT.",
    )
    process.exit(1)
  }

  let result
  try {
    result = syncVault({ vaultDirectory: vaultArg })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  console.log(`Synced ${result.copiedPages} player-facing Markdown pages.`)
  console.log(`Copied ${result.copiedAssets} referenced assets.`)

  if (result.disallowedReferences.length > 0) {
    console.error("Blocked references outside allowed player-facing/asset directories:")
    for (const reference of result.disallowedReferences) {
      console.error(`- ${reference}`)
    }
    process.exitCode = 1
  }

  if (result.missingReferences.length > 0) {
    console.error("Missing references:")
    for (const reference of result.missingReferences) {
      console.error(`- ${reference}`)
    }
    process.exitCode = 1
  }

  if (result.playerFacingDrift.length > 0) {
    console.error(
      `Player-facing export drift detected (re-sync in Obsidian with Player Facing Notes, then commit and push ${DEFAULT_PLAYER_FACING_DIR}/):`,
    )
    for (const issue of result.playerFacingDrift) {
      console.error(`- ${issue}`)
    }
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
