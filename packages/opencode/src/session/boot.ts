import fs from "fs/promises"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Session } from "."
import { SessionMemory } from "./memory"
import { SessionPrompt } from "./prompt"

type Plan = {
  items: string[]
  reply: boolean
}

export namespace SessionBoot {
  const log = Log.create({ service: "session.boot" })

  function parse(input: string): Plan {
    const items = [] as string[]
    let reply = false

    for (const row of input.split("\n")) {
      const line = row.trim()
      if (!line) continue
      if (line.startsWith("#")) continue

      if (line.startsWith("@reply ")) {
        const value = line.slice("@reply ".length).trim().toLowerCase()
        if (value === "true") reply = true
        if (value === "false") reply = false
        continue
      }

      items.push(line.startsWith("- ") ? line.slice(2).trim() : line)
    }

    return {
      items: items.filter(Boolean),
      reply,
    }
  }

  async function target() {
    const main = await Session.getByKey("main").catch(() => undefined)
    if (main && !main.time.archived) return main

    const recent = [...Session.list({ limit: 20 })].find((item) => !item.time.archived)
    if (recent) return recent

    return Session.create({ key: "main" })
  }

  async function ready(file: { identity: string; user: string }) {
    const identity = await Bun.file(file.identity)
      .text()
      .catch(() => "")
    const user = await Bun.file(file.user)
      .text()
      .catch(() => "")
    const name = identity.match(/^- Name:\s*(.*)$/m)?.[1]?.trim()
    const call = user.match(/^- What to call them:\s*(.*)$/m)?.[1]?.trim()
    return !!name && !!call
  }

  async function reconcile() {
    const file = SessionMemory.workspace(Instance.directory)
    const hasBootstrap = await Bun.file(file.bootstrap).exists()
    if (!hasBootstrap) return false

    const done = await ready(file)
    if (!done) return false

    await fs.rm(file.bootstrap, { force: true })
    await Bun.write(file.bootstrapDone, "done\n")
    log.info("bootstrap completed")
    return true
  }

  function text(items: string[]) {
    return [
      "[boot]",
      "Read .opencode/BOOT.md and execute startup tasks now.",
      "If you send external/public messages during this run, finish with NO_REPLY.",
      "",
      "Checklist:",
      ...items.map((item) => "- " + item),
    ].join("\n")
  }

  export async function run() {
    await reconcile()
    const file = SessionMemory.workspace(Instance.directory)
    const content = await Bun.file(file.boot)
      .text()
      .catch(() => "")
    const plan = parse(content)
    if (plan.items.length === 0) return false

    const session = await target()
    await SessionPrompt.prompt({
      sessionID: session.id,
      noReply: !plan.reply,
      parts: [
        {
          type: "text",
          text: text(plan.items),
        },
      ],
    })
    return true
  }
}
