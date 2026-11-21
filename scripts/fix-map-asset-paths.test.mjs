import assert from "node:assert/strict"
import test from "node:test"
import { prefixMapAssetUrls } from "./fix-map-asset-paths.mjs"

function mapHtml(url) {
  const config = {
    resolvedImageUrls: [{ url }],
  }
  const encoded = JSON.stringify(config).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
  return `<div data-qz-ttrpg-map-cfg="${encoded}"></div>`
}

function mapUrl(html) {
  const encoded = html.match(/data-qz-ttrpg-map-cfg="([^"]*)"/)?.[1]
  assert.ok(encoded)
  return JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, "&")).resolvedImageUrls[0].url
}

test("prefixes root-relative map assets with the project base path", () => {
  const output = prefixMapAssetUrls(mapHtml("/z_Assets/world map.jpg"), "/timescape-site")
  assert.equal(mapUrl(output), "/timescape-site/z_Assets/world map.jpg")
})

test("leaves root sites and already-prefixed map assets unchanged", () => {
  const html = mapHtml("/timescape-site/z_Assets/world.jpg")
  assert.equal(prefixMapAssetUrls(html, ""), html)
  assert.equal(prefixMapAssetUrls(html, "/timescape-site"), html)
})
