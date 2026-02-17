import { Log } from "@/util/log"
import { Scheduler } from "@/scheduler"
import { Session } from "."
import { SessionMemory } from "./memory"
import { Instance } from "@/project/instance"
import { SessionPrompt } from "./prompt"

export namespace SessionHeartbeat {
  const log = Log.create({ service: "session.heartbeat" })
  const minute = 60 * 1000
  const every = 30 * minute

  type Plan = {
    items: string[]
    every: number
    retry: number
    reply: boolean
    quiet?: {
      start: number
      end: number
    }
  }

  const state = Instance.state(() => {
    return {
      seen: new Map<string, string>(),
      plan: "",
      next: 0,
    }
  })

  function ms(input: string) {
    const match = input.trim().match(/^(\d+)(ms|s|m|h)$/i)
    if (!match) return
    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0) return
    const unit = match[2].toLowerCase()
    if (unit === "ms") return Math.max(value, minute)
    if (unit === "s") return Math.max(value * 1000, minute)
    if (unit === "m") return Math.max(value * minute, minute)
    if (unit === "h") return Math.max(value * 60 * minute, minute)
  }

  function hm(input: string) {
    const match = input.trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!match) return
    const hour = Number(match[1])
    const mins = Number(match[2])
    if (!Number.isInteger(hour) || !Number.isInteger(mins)) return
    if (hour < 0 || hour > 23) return
    if (mins < 0 || mins > 59) return
    return hour * 60 + mins
  }

  function sleeping(now: Date, quiet?: Plan["quiet"]) {
    if (!quiet) return false
    const current = now.getHours() * 60 + now.getMinutes()
    if (quiet.start === quiet.end) return false
    if (quiet.start < quiet.end) {
      return current >= quiet.start && current < quiet.end
    }
    return current >= quiet.start || current < quiet.end
  }

  export function parse(input: string): Plan {
    const items = [] as string[]
    let interval = every
    let retry = 5 * minute
    let reply = true
    let quiet: Plan["quiet"]

    for (const row of input.split("\n")) {
      const line = row.trim()
      if (!line) continue
      if (line.startsWith("#")) continue

      if (line.startsWith("@every ")) {
        const parsed = ms(line.slice("@every ".length))
        if (parsed) interval = parsed
        continue
      }

      if (line.startsWith("@retry ")) {
        const parsed = ms(line.slice("@retry ".length))
        if (parsed) retry = parsed
        continue
      }

      if (line.startsWith("@quiet ")) {
        const [left, right] = line.slice("@quiet ".length).trim().split("-")
        const start = left ? hm(left) : undefined
        const end = right ? hm(right) : undefined
        if (start !== undefined && end !== undefined) {
          quiet = { start, end }
        }
        continue
      }

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
      every: interval,
      retry,
      reply,
      quiet,
    }
  }

  export async function plan(directory: string) {
    const file = SessionMemory.workspace(directory).heartbeat
    const content = await Bun.file(file)
      .text()
      .catch(() => "")
    return parse(content)
  }

  export async function tasks(directory: string) {
    return plan(directory).then((x) => x.items)
  }

  function prompt(items: string[]) {
    return [
      "[heartbeat]",
      "Read .opencode/HEARTBEAT.md and execute it now.",
      "If nothing needs attention, reply exactly HEARTBEAT_OK.",
      "Do not infer old tasks from previous chats.",
      "",
      "Checklist:",
      ...items.map((item) => "- " + item),
    ].join("\n")
  }

  async function target() {
    const main = await Session.getByKey("main").catch(() => undefined)
    if (main && !main.time.archived) return main

    const recent = [...Session.list({ limit: 20 })].find((item) => !item.time.archived)
    if (recent) return recent

    return Session.create({ key: "main" })
  }

  export function init() {
    Scheduler.register({
      id: "session.memory.heartbeat",
      interval: minute,
      run,
      scope: "instance",
    })
  }

  export async function run() {
    const settings = await plan(Instance.directory)
    const text = JSON.stringify(settings)
    if (text !== state().plan) {
      state().plan = text
      state().next = 0
      if (settings.items.length > 0) {
        log.info("heartbeat plan loaded", {
          items: settings.items.length,
          every: settings.every,
          retry: settings.retry,
          reply: settings.reply,
          quiet: settings.quiet,
        })
      }
    }

    if (settings.items.length > 0) {
      const now = Date.now()
      const due = now >= state().next
      if (due) {
        if (sleeping(new Date(now), settings.quiet)) {
          state().next = now + minute
        } else {
          const session = await target()
          const ok = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: !settings.reply,
            parts: [
              {
                type: "text",
                text: prompt(settings.items),
              },
            ],
          })
            .then(() => true)
            .catch((error) => {
              log.warn("heartbeat prompt failed", {
                error,
                sessionID: session.id,
              })
              return false
            })
          state().next = now + (ok ? settings.every : settings.retry)
        }
      }
    }

    const sessions = [...Session.list({ limit: 50 })].filter((item) => !!item.key && !item.time.archived)
    for (const item of sessions) {
      await sync(item)
    }
  }

  export async function sync(session: Session.Info) {
    if (!session.key) return false
    const messages = await Session.messages({
      sessionID: session.id,
      limit: 48,
    })
    const tail = messages[messages.length - 1]?.info.id
    if (!tail) return false
    if (state().seen.get(session.id) === tail) return false
    const changed = await SessionMemory.update({
      session: {
        id: session.id,
        key: session.key,
        directory: session.directory,
      },
      messages,
    })
    state().seen.set(session.id, tail)
    if (changed) {
      log.info("updated", {
        sessionID: session.id,
        key: session.key,
      })
    }
    return changed
  }
}
