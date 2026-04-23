import { Instance } from "@/project/instance"
import { Log } from "@/util"
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
    const done = await SessionMemory.reconcile(Instance.directory)
    if (done) {
      log.info("bootstrap completed")
    }
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
