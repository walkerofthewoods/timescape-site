import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, relative, resolve, sep } from "node:path"
import { getSiteBasePath } from "./site-paths.mjs"

const outputDirectory = resolve("public")
const basePath = getSiteBasePath()
const port = Number(process.env.PORT ?? 4173)
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function findFile(pathname) {
  let decodedPath
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return undefined
  }

  const target = resolve(outputDirectory, `.${decodedPath}`)
  const relativeTarget = relative(outputDirectory, target)
  if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === "..") return undefined

  const candidates = decodedPath.endsWith("/")
    ? [join(target, "index.html")]
    : [target, `${target}.html`, join(target, "index.html")]

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

const server = createServer((request, response) => {
  let pathname
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname
  } catch {
    response.writeHead(400).end("Bad request")
    return
  }

  if (basePath) {
    if (pathname === basePath) pathname = "/"
    else if (pathname.startsWith(`${basePath}/`)) pathname = pathname.slice(basePath.length)
    else {
      response.writeHead(404).end("Not found")
      return
    }
  }

  const filePath = findFile(pathname)
  if (!filePath) {
    response.writeHead(404).end("Not found")
    return
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
  })
  createReadStream(filePath).pipe(response)
})

server.listen(port, "127.0.0.1", () => {
  console.log(`Serving ${outputDirectory} at http://127.0.0.1:${port}${basePath}/`)
})
