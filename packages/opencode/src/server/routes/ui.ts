import { Flag } from "@/flag/flag"
import { Hono } from "hono"
import { proxy } from "hono/proxy"
import { getMimeType } from "hono/utils/mime"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import nodePath from "node:path"

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

const localWebUICandidates = [
  nodePath.resolve(process.cwd(), "packages/app/dist"),
  nodePath.resolve(process.cwd(), "../app/dist"),
  nodePath.resolve(process.cwd(), "../../app/dist"),
]

async function localWebUIRoot() {
  for (const root of localWebUICandidates) {
    try {
      await fs.access(nodePath.join(root, "index.html"))
      return root
    } catch {}
  }
  return undefined
}

async function localWebUI(requestPath: string) {
  const root = await localWebUIRoot()
  if (!root) return null

  const index = nodePath.join(root, "index.html")
  const normalized = requestPath === "/" ? "/index.html" : requestPath
  const relative = normalized.replace(/^\/+/, "")
  const candidate = nodePath.normalize(nodePath.join(root, relative))

  if (!candidate.startsWith(root + nodePath.sep) && candidate !== index) return null

  try {
    const bytes = await fs.readFile(candidate)
    return { path: candidate, bytes }
  } catch {}

  try {
    const bytes = await fs.readFile(index)
    return { path: index, bytes }
  } catch {}
  return null
}

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c) => {
    const embeddedWebUI = await embeddedUIPromise
    const path = c.req.path

    const local = await localWebUI(path)
    if (local) {
      const mime = getMimeType(local.path) ?? "text/plain"
      c.header("Content-Type", mime)
      if (mime.startsWith("text/html")) {
        c.header("Content-Security-Policy", DEFAULT_CSP)
      }
      return c.body(new Uint8Array(local.bytes))
    }

    if (embeddedWebUI) {
      const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
      if (!match) return c.json({ error: "Not Found" }, 404)

      if (await fs.exists(match)) {
        const mime = getMimeType(match) ?? "text/plain"
        c.header("Content-Type", mime)
        if (mime.startsWith("text/html")) {
          c.header("Content-Security-Policy", DEFAULT_CSP)
        }
        return c.body(new Uint8Array(await fs.readFile(match)))
      } else {
        return c.json({ error: "Not Found" }, 404)
      }
    } else {
      const response = await proxy(`https://app.opencode.ai${path}`, {
        raw: c.req.raw,
        headers: {
          ...Object.fromEntries(c.req.raw.headers.entries()),
          host: "app.opencode.ai",
        },
      })
      const match = response.headers.get("content-type")?.includes("text/html")
        ? (await response.clone().text()).match(
            /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
          )
        : undefined
      const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
      response.headers.set("Content-Security-Policy", csp(hash))
      return response
    }
  })
