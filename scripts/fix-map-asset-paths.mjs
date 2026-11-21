import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

function decodeAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function encodeAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function prefixMapAssetUrls(html, basePath) {
  const prefix = basePath.replace(/\/+$/, "")
  if (!prefix) return html

  return html.replace(/data-qz-ttrpg-map-cfg="([^"]*)"/g, (attribute, encodedConfig) => {
    const config = JSON.parse(decodeAttribute(encodedConfig))
    let changed = false

    for (const image of config.resolvedImageUrls ?? []) {
      if (
        typeof image.url !== "string" ||
        !image.url.startsWith("/") ||
        image.url.startsWith("//") ||
        image.url === prefix ||
        image.url.startsWith(`${prefix}/`)
      ) {
        continue
      }

      image.url = `${prefix}${image.url}`
      changed = true
    }

    return changed
      ? `data-qz-ttrpg-map-cfg="${encodeAttribute(JSON.stringify(config))}"`
      : attribute
  })
}

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findHtmlFiles(entryPath)))
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(entryPath)
    }
  }

  return files
}

export async function fixMapAssetPaths(outputDirectory) {
  const htmlFiles = await findHtmlFiles(outputDirectory)
  let updated = 0

  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8")
    if (!html.includes("data-qz-ttrpg-map-cfg=")) continue

    const basePathMatch = html.match(/<body\b[^>]*\bdata-basepath="([^"]*)"/)
    if (!basePathMatch) {
      throw new Error(`Map configuration found without a data-basepath in ${file}`)
    }

    const basePath = decodeAttribute(basePathMatch[1])
    const output = prefixMapAssetUrls(html, basePath)
    if (output !== html) {
      await writeFile(file, output, "utf8")
      updated++
    }
  }

  return updated
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const outputDirectory = path.resolve(process.argv[2] ?? "public")
  const updated = await fixMapAssetPaths(outputDirectory)
  console.log(`Updated map asset paths in ${updated} HTML file(s).`)
}
