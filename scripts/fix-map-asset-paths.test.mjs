import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fixMapAssetPaths, prefixMapAssetUrls } from "./fix-map-asset-paths.mjs"

function mapHtml(url, { sourcePath, bodyAttrs = "" } = {}) {
  const image = { url }
  if (sourcePath !== undefined) image.sourcePath = sourcePath
  const config = {
    resolvedImageUrls: [image],
  }
  const encoded = JSON.stringify(config).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
  return `<html lang="en"><body ${bodyAttrs}><div data-qz-ttrpg-map-cfg="${encoded}"></div></body></html>`
}

function mapConfig(html) {
  const encoded = html.match(/data-qz-ttrpg-map-cfg="([^"]*)"/)?.[1]
  assert.ok(encoded)
  return JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
}

test("prefixes root-relative map assets with the project base path and strips sourcePath", () => {
  const output = prefixMapAssetUrls(
    mapHtml("/z_Assets/world map.jpg", { sourcePath: "C:\\vault\\z_Assets\\world map.jpg" }),
    "/timescape-site",
  )
  const image = mapConfig(output).resolvedImageUrls[0]
  assert.equal(image.url, "/timescape-site/z_Assets/world map.jpg")
  assert.equal("sourcePath" in image, false)
})

test("strips sourcePath even when basePath is empty and leaves already-prefixed URLs unchanged", () => {
  const rootOutput = prefixMapAssetUrls(
    mapHtml("/z_Assets/world.jpg", { sourcePath: "/tmp/vault/world.jpg" }),
    "",
  )
  const rootImage = mapConfig(rootOutput).resolvedImageUrls[0]
  assert.equal(rootImage.url, "/z_Assets/world.jpg")
  assert.equal("sourcePath" in rootImage, false)

  const alreadyPrefixed = mapHtml("/timescape-site/z_Assets/world.jpg")
  assert.equal(prefixMapAssetUrls(alreadyPrefixed, ""), alreadyPrefixed)
  assert.equal(prefixMapAssetUrls(alreadyPrefixed, "/timescape-site"), alreadyPrefixed)
})

test("fixMapAssetPaths handles both valueless and valued data-basepath attributes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timescape-fix-maps-"))
  try {
    const valuelessPath = join(dir, "serve.html")
    const valuedPath = join(dir, "build.html")

    writeFileSync(
      valuelessPath,
      mapHtml("/z_Assets/world.jpg", {
        sourcePath: "C:\\local\\world.jpg",
        bodyAttrs: 'data-slug="map" data-basepath',
      }),
      "utf8",
    )
    writeFileSync(
      valuedPath,
      mapHtml("/z_Assets/world.jpg", {
        sourcePath: "C:\\local\\world.jpg",
        bodyAttrs: 'data-slug="map" data-basepath="/timescape-site"',
      }),
      "utf8",
    )

    const updated = await fixMapAssetPaths(dir)
    assert.equal(updated, 2)

    const serveImg = mapConfig(readFileSync(valuelessPath, "utf8")).resolvedImageUrls[0]
    assert.equal(serveImg.url, "/z_Assets/world.jpg")
    assert.equal("sourcePath" in serveImg, false)

    const buildImg = mapConfig(readFileSync(valuedPath, "utf8")).resolvedImageUrls[0]
    assert.equal(buildImg.url, "/timescape-site/z_Assets/world.jpg")
    assert.equal("sourcePath" in buildImg, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
