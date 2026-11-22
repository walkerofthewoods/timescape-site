import { readFileSync } from "node:fs"
import { parse } from "yaml"

export function getSiteBasePath() {
  const config = parse(readFileSync(new URL("../quartz.config.yaml", import.meta.url), "utf8"))
  const baseUrl = config.configuration.baseUrl
  if (!baseUrl) return ""

  return new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).pathname.replace(
    /\/+$/,
    "",
  )
}
