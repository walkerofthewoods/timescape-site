import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { fromHtml } from "hast-util-from-html"
import { getSiteBasePath } from "./site-paths.mjs"

function findHtmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) return findHtmlFiles(entryPath)
    return entry.isFile() && extname(entry.name) === ".html" ? [entryPath] : []
  })
}

function getTextContent(node) {
  if (!node) return ""
  if (node.type === "text") return node.value ?? ""
  return (node.children ?? []).map(getTextContent).join("")
}

function hasClass(node, className) {
  const classes = node.properties?.className
  if (Array.isArray(classes)) return classes.includes(className)
  if (typeof classes === "string") return classes.split(/\s+/).includes(className)
  return false
}

function collectPageInspectables(tree) {
  const anchors = []
  const mediaSrcs = []
  const headings = []
  const maps = []

  const walk = (node) => {
    if (node.type === "element") {
      if (node.tagName === "a") {
        const href = node.properties?.href
        if (typeof href === "string" && href.length > 0) anchors.push(href)
      }

      if (
        node.tagName === "img" ||
        node.tagName === "video" ||
        node.tagName === "audio" ||
        node.tagName === "source"
      ) {
        const src = node.properties?.src
        if (typeof src === "string" && src.length > 0) mediaSrcs.push(src)
      }

      if (node.tagName === "h1") {
        headings.push(getTextContent(node).trim())
      }

      if (node.properties?.dataQzTtrpgMapCfg !== undefined || hasClass(node, "ttrpg-map-root")) {
        maps.push(node)
      }
    }

    for (const child of node.children ?? []) walk(child)
  }

  walk(tree)
  return { anchors, mediaSrcs, headings, maps }
}

function outputCandidates(pathname, outputDirectory) {
  const relativePath = pathname.replace(/^\/+/, "")
  const target = resolve(outputDirectory, relativePath)
  const withinOutput =
    target === outputDirectory ||
    (!relative(outputDirectory, target).startsWith(`..${sep}`) &&
      relative(outputDirectory, target) !== "..")

  if (!withinOutput) return []
  if (pathname.endsWith("/") || pathname === "") return [resolve(target, "index.html")]
  if (extname(target)) return [target]
  return [`${target}.html`, resolve(target, "index.html")]
}

function isInternalTargetValid(targetUrl, pagePath, outputDirectory, basePath) {
  if (/^(?:mailto:|tel:|javascript:|data:)/i.test(targetUrl) || targetUrl.startsWith("#")) {
    return true
  }

  let destination
  try {
    destination = new URL(targetUrl, `https://site.invalid/${pagePath}`)
  } catch {
    return false
  }

  if (destination.origin !== "https://site.invalid") return true

  let pathname
  try {
    pathname = decodeURIComponent(destination.pathname)
  } catch {
    return false
  }

  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    pathname = pathname.slice(basePath.length) || "/"
  }

  return outputCandidates(pathname, outputDirectory).some(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  )
}

function verifyMapNode(mapNode, pagePath, outputDirectory, basePath, errors) {
  const props = mapNode.properties ?? {}
  if (props.dataQzTtrpgMapError) {
    errors.push(`${pagePath}: map rendered error state "${props.dataQzTtrpgMapError}"`)
  }

  if (typeof props.dataQzTtrpgMapCfg !== "string") {
    errors.push(`${pagePath}: map element is missing data-qz-ttrpg-map-cfg`)
    return
  }

  let cfg
  try {
    cfg = JSON.parse(props.dataQzTtrpgMapCfg)
  } catch {
    errors.push(`${pagePath}: invalid JSON in data-qz-ttrpg-map-cfg`)
    return
  }

  if (cfg.error) {
    errors.push(`${pagePath}: map configuration contains error "${cfg.error}"`)
  }

  if (typeof props.dataQzTtrpgMapData !== "string") {
    errors.push(`${pagePath}: map element is missing data-qz-ttrpg-map-data`)
  } else {
    try {
      JSON.parse(props.dataQzTtrpgMapData)
    } catch {
      errors.push(`${pagePath}: invalid JSON in data-qz-ttrpg-map-data`)
    }
  }

  const images = cfg.resolvedImageUrls ?? []
  if (!Array.isArray(images) || images.length === 0) {
    errors.push(`${pagePath}: map resolvedImageUrls is empty`)
    return
  }

  for (const image of images) {
    if ("sourcePath" in image) {
      errors.push(`${pagePath}: map config leaks local sourcePath`)
    }
    if (typeof image.url !== "string" || image.url.length === 0) {
      errors.push(`${pagePath}: map image entry is missing url`)
      continue
    }
    if (basePath && !image.url.startsWith(`${basePath}/`)) {
      errors.push(`${pagePath}: map asset url "${image.url}" is missing basePath "${basePath}/"`)
    }
    if (!isInternalTargetValid(image.url, pagePath, outputDirectory, basePath)) {
      errors.push(`${pagePath}: map asset missing in output: ${image.url}`)
    }
  }
}

export function checkBuiltSite(
  outputDirectory = resolve("public"),
  { basePath = getSiteBasePath() } = {},
) {
  const normalizedBasePath = basePath.replace(/\/+$/, "")
  const indexHtmlPath = resolve(outputDirectory, "index.html")
  if (!existsSync(indexHtmlPath)) {
    throw new Error(`No built homepage found in ${outputDirectory}. Build the site first.`)
  }

  const errors = []
  const contentIndexPath = resolve(outputDirectory, "static", "contentIndex.json")
  if (!existsSync(contentIndexPath)) {
    errors.push("Missing static/contentIndex.json in build output.")
  } else {
    try {
      const contentIndex = JSON.parse(readFileSync(contentIndexPath, "utf8"))
      const slugs = Object.keys(contentIndex)
      if (slugs.length === 0) {
        errors.push("static/contentIndex.json contains 0 entries.")
      } else {
        for (const slug of slugs) {
          const candidates =
            slug === "index"
              ? [indexHtmlPath]
              : [
                  resolve(outputDirectory, `${slug}.html`),
                  resolve(outputDirectory, slug, "index.html"),
                ]
          if (
            !candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile())
          ) {
            errors.push(`contentIndex slug missing emitted HTML file: ${slug}`)
          }
        }
      }
    } catch {
      errors.push("static/contentIndex.json is not valid JSON.")
    }
  }

  const htmlFiles = findHtmlFiles(outputDirectory)
  let checkedLinks = 0
  let checkedMedia = 0
  let checkedMaps = 0

  for (const htmlFile of htmlFiles) {
    const pagePath = relative(outputDirectory, htmlFile).split(sep).join("/")
    const tree = fromHtml(readFileSync(htmlFile, "utf8"))
    const { anchors, mediaSrcs, headings, maps } = collectPageInspectables(tree)

    if (pagePath !== "404.html" && !headings.some((text) => text.length > 0)) {
      errors.push(`${pagePath}: missing non-empty <h1> heading`)
    }

    for (const href of anchors) {
      checkedLinks++
      if (!isInternalTargetValid(href, pagePath, outputDirectory, normalizedBasePath)) {
        errors.push(`${pagePath}: broken internal link "${href}"`)
      }
    }

    for (const src of mediaSrcs) {
      checkedMedia++
      if (!isInternalTargetValid(src, pagePath, outputDirectory, normalizedBasePath)) {
        errors.push(`${pagePath}: missing local media "${src}"`)
      }
    }

    for (const mapNode of maps) {
      checkedMaps++
      verifyMapNode(mapNode, pagePath, outputDirectory, normalizedBasePath, errors)
    }
  }

  return {
    htmlFiles: htmlFiles.length,
    checkedLinks,
    checkedMedia,
    checkedMaps,
    errors,
  }
}

function main() {
  const result = checkBuiltSite(resolve(process.argv[2] ?? "public"))
  if (result.errors.length > 0) {
    console.error(`Site verification failed with ${result.errors.length} issue(s):`)
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exitCode = 1
    return
  }

  console.log(
    `Verified ${result.htmlFiles} HTML files (${result.checkedLinks} links, ${result.checkedMedia} media refs, ${result.checkedMaps} maps).`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
