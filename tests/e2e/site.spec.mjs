import { readdirSync, readFileSync } from "node:fs"
import { extname, relative, resolve, sep } from "node:path"
import { expect, test } from "@playwright/test"

function discoverMapRoutes(outputDir = resolve("public")) {
  const routes = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && extname(entry.name) === ".html") {
        const html = readFileSync(fullPath, "utf8")
        if (!html.includes("data-qz-ttrpg-map-cfg=")) continue
        const rel = relative(outputDir, fullPath).split(sep).join("/")
        if (rel === "index.html") routes.push("./")
        else if (rel.endsWith("/index.html")) routes.push(rel.slice(0, -"index.html".length))
        else routes.push(rel.slice(0, -".html".length))
      }
    }
  }

  walk(outputDir)
  return routes.sort()
}

async function trackPageHealth(page, baseURL) {
  const baseOrigin = new URL(baseURL).origin
  const pageErrors = []
  const failedResponses = []

  await page.route("https://**/*", (route) => route.abort())

  page.on("pageerror", (error) => {
    pageErrors.push(error.message)
  })

  page.on("response", (response) => {
    const url = response.url()
    if (url.startsWith(baseOrigin) && response.status() >= 400) {
      failedResponses.push(`${response.status()} ${url}`)
    }
  })

  return {
    assertClean() {
      expect(pageErrors, "unexpected page errors").toEqual([])
      expect(failedResponses, "unexpected failed local HTTP responses").toEqual([])
    },
  }
}

test("homepage, explorer sidebar, and SPA navigation work without errors", async ({
  page,
  baseURL,
}) => {
  const health = await trackPageHealth(page, baseURL)
  const response = await page.goto("./", { waitUntil: "domcontentloaded" })

  expect(response?.status()).toBe(200)
  await expect(page.locator("h1.article-title")).toHaveText("The Timescape")
  await expect(page.locator(".explorer-ul a").first()).toBeVisible()

  const journalsLink = page.locator("article").getByRole("link", { name: "Session Journals" })
  await expect(journalsLink).toHaveAttribute("href", /campaigns\/the-condemned\/session-journals\//)
  await journalsLink.click()

  await expect(page.locator("h1.article-title")).toHaveText("Session Journals")
  health.assertClean()
})

test("client-side search finds and navigates to a page", async ({ page, baseURL }) => {
  const health = await trackPageHealth(page, baseURL)
  await page.goto("./", { waitUntil: "domcontentloaded" })

  await page.locator(".search-button").click()
  await expect(page.locator(".search-container")).toHaveClass(/\bactive\b/)

  const searchInput = page.locator("input.search-bar")
  await searchInput.fill("Vorona")

  const result = page
    .locator(".results-container .result-card", { hasText: "House Vorona" })
    .first()
  await expect(result).toBeVisible()
  await result.click()

  await expect(page.locator("h1.article-title")).toHaveText("House Vorona")
  health.assertClean()
})

test("representative interactive map loads image and renders cleanly", async ({
  page,
  baseURL,
}) => {
  const mapRoutes = discoverMapRoutes()
  expect(mapRoutes.length, "expected at least one built map page").toBeGreaterThan(0)
  const targetRoute =
    mapRoutes.find((route) => route === "atlas-of-time/maps/vasloria") ?? mapRoutes[0]

  const health = await trackPageHealth(page, baseURL)
  const imageResponsePromise = page.waitForResponse(
    (response) =>
      /\.(?:jpe?g|png|webp|avif|gif|svg)(?:$|\?)/i.test(new URL(response.url()).pathname) &&
      response.url().includes("/z_Assets/"),
  )

  await page.goto(targetRoute, { waitUntil: "domcontentloaded" })

  const imageResponse = await imageResponsePromise
  expect(imageResponse.status(), targetRoute).toBe(200)

  const mapRoot = page.locator(".ttrpg-map-root").first()
  await expect(mapRoot).toBeVisible()

  const mapImage = mapRoot.locator("img.zm-image")
  await expect(mapImage).toBeVisible()
  await expect
    .poll(() => mapImage.evaluate((img) => img.complete && img.naturalWidth > 0))
    .toBe(true)

  await expect(page.locator(".ttrpg-map-error")).toHaveCount(0)
  await expect(mapRoot.locator(".zm-hud__panel")).toBeHidden()
  health.assertClean()
})

test("Vasloria map fits a mobile viewport", async ({ page, baseURL }) => {
  const health = await trackPageHealth(page, baseURL)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("atlas-of-time/maps/vasloria", { waitUntil: "domcontentloaded" })

  const map = page.locator(".ttrpg-map-root")
  await expect(map).toBeVisible()
  const mapImage = map.locator("img.zm-image")
  await expect
    .poll(() => mapImage.evaluate((img) => img.complete && img.naturalWidth > 0))
    .toBe(true)
  await expect(page.locator(".ttrpg-map-error")).toHaveCount(0)

  const bounds = await map.boundingBox()
  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))

  expect(bounds).not.toBeNull()
  expect(bounds.width).toBeLessThanOrEqual(viewport.width)
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width)
  expect(bounds.height).toBeGreaterThanOrEqual(viewport.height * 0.7)
  health.assertClean()
})
