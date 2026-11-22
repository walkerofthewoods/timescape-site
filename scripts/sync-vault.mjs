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

  return {
    copiedPages,
    copiedAssets: copiedExtraAssets,
    missingReferences: [...missingReferences].sort(),
    disallowedReferences: [...disallowedReferences].sort(),
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
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
