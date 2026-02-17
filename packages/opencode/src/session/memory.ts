import fs from "fs/promises"
import path from "path"
import z from "zod"
import { fn } from "@/util/fn"
import type { MessageV2 } from "./message-v2"

const MAX_SYSTEM_CHARS = 6000
const DAY = 24 * 60 * 60 * 1000

const SOUL_TEMPLATE = `# SOUL.md - Who You Are

You are a practical coding assistant.

## Core Truths

- Be genuinely helpful and direct.
- Be resourceful before asking questions.
- Protect user privacy and avoid risky external actions unless asked.
- Keep a clear opinion on tradeoffs when it helps the user decide.

## Boundaries

- Private data stays private.
- Ask before external/public actions.
- Avoid destructive commands unless explicitly requested.

## Continuity

You wake up fresh each session. Read and update workspace memory files.
`

const TOOLS_TEMPLATE = `# TOOLS.md - Local Notes

This file stores environment-specific notes for this project.

## What to put here

- Hosts, aliases, and local endpoints
- Device names and nicknames
- Tool-specific preferences and defaults

## Notes

- Keep this practical and current.
- Avoid storing secrets in plaintext.
`

const IDENTITY_TEMPLATE = `# IDENTITY.md - Who Am I?

- Name:
- Role: coding assistant
- Vibe: practical and direct
- Emoji: :robot:

Use this file to define stable identity traits for this project.
`

const USER_TEMPLATE = `# USER.md - About Your Human

- Name:
- What to call them:
- Timezone:
- Notes:

Use this file for stable user preferences and profile notes.
`

const HEARTBEAT_TEMPLATE = `# HEARTBEAT.md

# Keep this file empty (or comments only) to skip heartbeat agent calls.
# Add short checklist items when you want periodic proactive checks.

# Example:
# - Check for urgent TODOs and open issues
# - Review upcoming release tasks
`

const BOOT_TEMPLATE = `# BOOT.md

# Add short startup tasks here.
# The startup runner will read this file on instance boot.
# Keep tasks concise and safe for automatic execution.

# Example:
# - Check git status and report blockers
# - Review today's memory notes
`

const BOOTSTRAP_TEMPLATE = `# BOOTSTRAP.md - Hello, World

You just woke up. This project is a fresh workspace.

1. Ask who you are and who the user is.
2. Fill IDENTITY.md and USER.md with real values.
3. Review SOUL.md together and refine tone/boundaries.
4. Delete this file once onboarding is complete.
`

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

  export const EnsureInput = z.object({
    directory: z.string(),
  })

  function clean(key: string) {
    return key.replace(/[^a-z0-9._-]/gi, "_")
  }

  function main(key?: string) {
    if (!key) return false
    return key.trim().toLowerCase() === "main"
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

  function date(ms = Date.now()) {
    return new Date(ms).toISOString().slice(0, 10)
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

  async function create(file: string, content: string) {
    const found = await Bun.file(file).exists()
    if (found) return false
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, content.trim() + "\n")
    return true
  }

  export function workspace(directory: string) {
    const root = path.join(directory, ".opencode")
    return {
      root,
      soul: path.join(root, "SOUL.md"),
      tools: path.join(root, "TOOLS.md"),
      identity: path.join(root, "IDENTITY.md"),
      user: path.join(root, "USER.md"),
      heartbeat: path.join(root, "HEARTBEAT.md"),
      boot: path.join(root, "BOOT.md"),
      bootstrap: path.join(root, "BOOTSTRAP.md"),
      bootstrapDone: path.join(root, ".bootstrap.done"),
    }
  }

  export function daily(directory: string, now = Date.now()) {
    const root = path.join(directory, ".opencode", "memory")
    return {
      today: path.join(root, date(now) + ".md"),
      yesterday: path.join(root, date(now - DAY) + ".md"),
    }
  }

  export function paths(input: Input) {
    const root = path.join(input.directory, ".opencode", "memory")
    const key = input.key?.trim()
    const user = workspace(input.directory).user
    return {
      root,
      user,
      legacy: path.join(root, "USER.md"),
      memory: path.join(root, "MEMORY.md"),
      session: key ? path.join(root, "session", clean(key) + ".md") : undefined,
    }
  }

  export const system = fn(Input, async (input) => {
    await SessionMemory.ensure({ directory: input.directory })
    const local = workspace(input.directory)
    const file = paths(input)
    const logs = daily(input.directory)
    const list = Array.from(
      new Set(
        [
          local.bootstrap,
          local.soul,
          local.identity,
          local.user,
          local.tools,
          logs.yesterday,
          logs.today,
          file.session,
          file.legacy,
          ...(main(input.key) ? [file.memory] : []),
        ].filter((item): item is string => !!item),
      ),
    )
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
    const logs = daily(input.session.directory)
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
      ...(assists.length ? ["- Recent assistant output:", ...assists.map((line) => "  - " + short(line))] : []),
    ].join("\n")

    const projectBlock = [
      "## " + stamp,
      "",
      "- Key: " + input.session.key,
      "- Session: " + input.session.id,
      "- Last user request: " + short(users[users.length - 1] ?? assists[assists.length - 1] ?? ""),
    ].join("\n")

    const dailyBlock = [
      "## " + stamp,
      "",
      "- Key: " + input.session.key,
      "- Session: " + input.session.id,
      "- User:",
      ...users.map((line) => "  - " + short(line)),
      ...(assists.length ? ["- Assistant:", ...assists.map((line) => "  - " + short(line))] : []),
    ].join("\n")

    const userBlock = prefs.length
      ? ["## " + stamp, "", "- Inferred preferences:", ...prefs.map((line) => "  - " + line)].join("\n")
      : ""

    await fs.mkdir(file.root, { recursive: true })
    if (file.session) await fs.mkdir(path.dirname(file.session), { recursive: true })

    await append(logs.today, marker, dailyBlock)
    if (file.session) await append(file.session, marker, sessionBlock)

    if (main(input.session.key)) {
      await append(file.memory, marker, projectBlock)
      if (userBlock) {
        await append(file.user, marker, userBlock)
        if (await Bun.file(file.legacy).exists()) {
          await append(file.legacy, marker, userBlock)
        }
      }
    }

    return true
  })

  export const ensure = fn(EnsureInput, async (input) => {
    const file = workspace(input.directory)
    const done = await Bun.file(file.bootstrapDone).exists()
    const result = await Promise.all([
      create(file.soul, SOUL_TEMPLATE),
      create(file.tools, TOOLS_TEMPLATE),
      create(file.identity, IDENTITY_TEMPLATE),
      create(file.user, USER_TEMPLATE),
      create(file.heartbeat, HEARTBEAT_TEMPLATE),
      create(file.boot, BOOT_TEMPLATE),
      ...(done ? [] : [create(file.bootstrap, BOOTSTRAP_TEMPLATE)]),
    ])
    return result.some(Boolean)
  })
}
