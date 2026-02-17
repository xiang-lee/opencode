import fs from "fs/promises"
import path from "path"
import z from "zod"
import { fn } from "@/util/fn"
import type { MessageV2 } from "./message-v2"

const MAX_SYSTEM_CHARS = 6000

export namespace SessionMemory {
  export const Input = z.object({
    id: z.string(),
    key: z.string().optional(),
    directory: z.string(),
  })
  export type Input = z.infer<typeof Input>

  export const UpdateInput = z.object({
    session: Input,
    messages: z.custom<MessageV2.WithParts[]>(),
  })

  function clean(key: string) {
    return key.replace(/[^a-z0-9._-]/gi, "_")
  }

  function short(text: string, max = 220) {
    const value = text.trim().replace(/\s+/g, " ")
    if (value.length <= max) return value
    return value.slice(0, max - 3) + "..."
  }

  function isText(part: MessageV2.Part): part is MessageV2.TextPart {
    if (part.type !== "text") return false
    return !part.ignored
  }

  function read(part: MessageV2.WithParts) {
    return part.parts
      .filter(isText)
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n")
  }

  function limit(text: string, max = MAX_SYSTEM_CHARS) {
    if (text.length <= max) return text
    return "...(truncated)\n" + text.slice(-max)
  }

  async function text(file: string) {
    return Bun.file(file)
      .text()
      .catch(() => "")
  }

  async function append(file: string, marker: string, block: string) {
    const prev = await text(file)
    if (prev.includes(marker)) return false
    const next = [prev.trim(), marker, block].filter(Boolean).join("\n\n") + "\n"
    await Bun.write(file, next)
    return true
  }

  export function paths(input: Input) {
    const root = path.join(input.directory, ".opencode", "memory")
    const key = input.key?.trim()
    return {
      root,
      user: path.join(root, "USER.md"),
      memory: path.join(root, "MEMORY.md"),
      session: key ? path.join(root, "session", clean(key) + ".md") : undefined,
    }
  }

  export const system = fn(Input, async (input) => {
    const file = paths(input)
    const list = [file.session, file.user, file.memory].filter((item): item is string => !!item)
    const output = await Promise.all(
      list.map(async (item) => {
        const content = await text(item).then((x) => x.trim())
        if (!content) return
        return "Memory from: " + item + "\n" + limit(content)
      }),
    )
    return output.filter((item): item is string => !!item)
  })

  export const update = fn(UpdateInput, async (input) => {
    if (!input.session.key) return false
    const file = paths(input.session)
    const tail = input.messages[input.messages.length - 1]?.info.id
    if (!tail) return false

    const recent = input.messages.slice(-24)
    const users = recent
      .filter((item) => item.info.role === "user")
      .map(read)
      .filter(Boolean)
      .slice(-6)
    const assists = recent
      .filter((item) => item.info.role === "assistant")
      .map(read)
      .filter(Boolean)
      .slice(-4)
    if (users.length === 0 && assists.length === 0) return false

    const prefs = Array.from(
      new Set(
        users
          .flatMap((line) => line.split("\n"))
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => /(prefer|always|never|remember|please)/i.test(line))
          .map((line) => short(line, 200))
          .slice(-8),
      ),
    )

    const stamp = new Date().toISOString()
    const marker = "<!-- hb:" + tail + " -->"
    const sessionBlock = [
      "## " + stamp,
      "",
      "- Session: " + input.session.id,
      "- Key: " + input.session.key,
      "- Recent user intent:",
      ...users.map((line) => "  - " + short(line)),
      ...(assists.length
        ? ["- Recent assistant output:", ...assists.map((line) => "  - " + short(line))]
        : []),
    ].join("\n")

    const projectBlock = [
      "## " + stamp,
      "",
      "- Key: " + input.session.key,
      "- Session: " + input.session.id,
      "- Last user request: " + short(users[users.length - 1] ?? assists[assists.length - 1] ?? ""),
    ].join("\n")

    const userBlock = prefs.length
      ? ["## " + stamp, "", "- Inferred preferences:", ...prefs.map((line) => "  - " + line)].join("\n")
      : ""

    await fs.mkdir(file.root, { recursive: true })
    if (file.session) await fs.mkdir(path.dirname(file.session), { recursive: true })
    await append(file.memory, marker, projectBlock)
    if (file.session) await append(file.session, marker, sessionBlock)
    if (userBlock) await append(file.user, marker, userBlock)
    return true
  })
}
