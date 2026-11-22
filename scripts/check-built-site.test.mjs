import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { checkBuiltSite } from "./check-built-site.mjs"

function writeSiteFile(root, relPath, content = "") {
  const fullPath = join(root, ...relPath.split("/"))
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, "utf8")
}

function encodeAttr(obj) {
  return JSON.stringify(obj).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

function createValidSiteFixture() {
  const root = mkdtempSync(join(tmpdir(), "timescape-check-site-"))
  writeSiteFile(
    root,
    "index.html",
    '<html><body><h1>Home</h1><a href="./map">Map</a><img src="./z_Assets/crest.png"/></body></html>',
  )
  writeSiteFile(
    root,
    "map.html",
    `<html><body><h1>Map</h1><div class="ttrpg-map-root" data-qz-ttrpg-map-cfg="${encodeAttr({
      resolvedImageUrls: [{ url: "/timescape-site/z_Assets/map.jpg" }],
    })}" data-qz-ttrpg-map-data="${encodeAttr({ markers: [] })}"></div></body></html>`,
  )
  writeSiteFile(root, "404.html", "<html><body><p>Not Found</p></body></html>")
  writeSiteFile(root, "z_Assets/crest.png", "png")
  writeSiteFile(root, "z_Assets/map.jpg", "jpg")
  writeSiteFile(
    root,
    "static/contentIndex.json",
    JSON.stringify({
      index: { slug: "index" },
      map: { slug: "map" },
    }),
  )
  return root
}

test("checkBuiltSite passes for a valid built site", () => {
  const root = createValidSiteFixture()
  try {
    const result = checkBuiltSite(root, { basePath: "/timescape-site" })
    assert.deepEqual(result.errors, [])
    assert.equal(result.htmlFiles, 3)
    assert.equal(result.checkedLinks, 1)
    assert.equal(result.checkedMedia, 1)
    assert.equal(result.checkedMaps, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("checkBuiltSite catches broken links, missing media, missing headings, and map defects", () => {
  const root = createValidSiteFixture()
  try {
    writeSiteFile(
      root,
      "broken.html",
      [
        "<html><body>",
        '<a href="./does-not-exist">Broken</a>',
        '<img src="./z_Assets/missing.png"/>',
        `<div class="ttrpg-map-root" data-qz-ttrpg-map-error="markers-missing" data-qz-ttrpg-map-cfg="${encodeAttr(
          {
            resolvedImageUrls: [{ url: "/z_Assets/map.jpg", sourcePath: "C:\\secret\\map.jpg" }],
          },
        )}"></div>`,
        "</body></html>",
      ].join(""),
    )

    const result = checkBuiltSite(root, { basePath: "/timescape-site" })
    assert.ok(result.errors.some((e) => e.includes("missing non-empty <h1>")))
    assert.ok(result.errors.some((e) => e.includes('broken internal link "./does-not-exist"')))
    assert.ok(result.errors.some((e) => e.includes('missing local media "./z_Assets/missing.png"')))
    assert.ok(result.errors.some((e) => e.includes('error state "markers-missing"')))
    assert.ok(result.errors.some((e) => e.includes("missing data-qz-ttrpg-map-data")))
    assert.ok(result.errors.some((e) => e.includes("leaks local sourcePath")))
    assert.ok(result.errors.some((e) => e.includes('missing basePath "/timescape-site/"')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
