import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import { fn } from "@/util/fn"
import { Session } from "."
import { SessionPrompt } from "./prompt"

const tick = 30 * 1000
const MAX_SCAN_MINUTES = 366 * 24 * 60

type CronSpec = {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
}

const timezoneValues = (() => {
  const values = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone")
  if (!values) return
  return new Set(values)
})()

const formatters = new Map<string, Intl.DateTimeFormat>()

const WEEKDAY: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

function clock(ms: number, tz?: string) {
  const zone = tz?.trim()
  const allowed = zone && (!timezoneValues || timezoneValues.has(zone)) ? zone : undefined

  if (!allowed) {
    const date = new Date(ms)
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      weekday: date.getDay(),
    }
  }

  let format = formatters.get(allowed)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: allowed,
      hour12: false,
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
    })
    formatters.set(allowed, format)
  }

  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((item) => [item.type, item.value]))
  const minute = Number(parts.minute)
  const hour = Number(parts.hour)
  const day = Number(parts.day)
  const month = Number(parts.month)
  const weekday = WEEKDAY[(parts.weekday ?? "").slice(0, 3).toLowerCase()]

  if (![minute, hour, day, month].every(Number.isFinite) || weekday === undefined) return

  return {
    minute,
    hour,
    day,
    month,
    weekday,
  }
}

function parseAt(value: string) {
  const text = value.trim()
  if (!text) return
  const hasZone = /(?:z|[+-]\d{2}:\d{2})$/i.test(text)
  const parsed = Date.parse(hasZone ? text : `${text}Z`)
  if (!Number.isFinite(parsed)) return
  return parsed
}

function expand(input: string, min: number, max: number, weekday = false) {
  const out = new Set<number>()
  const list = input.split(",").map((item) => item.trim())
  if (list.length === 0 || list.some((item) => !item)) return

  for (const item of list) {
    const [rangeText, stepText] = item.split("/")
    if (!rangeText || item.split("/").length > 2) return
    const step = stepText ? Number(stepText) : 1
    if (!Number.isInteger(step) || step <= 0) return

    const push = (value: number) => {
      const normalized = weekday && value === 7 ? 0 : value
      if (normalized < min || normalized > max) return
      out.add(normalized)
    }

    if (rangeText === "*") {
      for (let value = min; value <= max; value += step) {
        push(value)
      }
      continue
    }

    if (rangeText.includes("-")) {
      const [startText, endText] = rangeText.split("-")
      const start = Number(startText)
      const end = Number(endText)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return
      for (let value = start; value <= end; value += step) {
        push(value)
      }
      continue
    }

    const value = Number(rangeText)
    if (!Number.isInteger(value)) return
    push(value)
  }

  return out
}

function parseCron(expr: string) {
  const parts = expr
    .trim()
    .split(/\s+/)
    .map((item) => item.trim())
  if (parts.length !== 5) return

  const minute = expand(parts[0], 0, 59)
  const hour = expand(parts[1], 0, 23)
  const day = expand(parts[2], 1, 31)
  const month = expand(parts[3], 1, 12)
  const weekday = expand(parts[4], 0, 6, true)

  if (!minute || !hour || !day || !month || !weekday) return

  return {
    minute,
    hour,
    day,
    month,
    weekday,
  } satisfies CronSpec
}

function nextCron(expr: string, now: number, tz?: string) {
  const spec = parseCron(expr)
  if (!spec) return
  const start = Math.floor(now / 60_000) * 60_000
  for (let i = 1; i <= MAX_SCAN_MINUTES; i++) {
    const current = start + i * 60_000
    const item = clock(current, tz)
    if (!item) continue
    if (!spec.minute.has(item.minute)) continue
    if (!spec.hour.has(item.hour)) continue
    if (!spec.day.has(item.day)) continue
    if (!spec.month.has(item.month)) continue
    if (!spec.weekday.has(item.weekday)) continue
    return current
  }
}

function nextEvery(everyMs: number, now: number, anchor?: number) {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return
  const base = Number.isFinite(anchor) ? Math.floor(anchor!) : now
  if (now < base) return base
  const step = Math.floor(everyMs)
  const elapsed = now - base
  const turns = Math.floor(elapsed / step) + 1
  return base + turns * step
}

export namespace SessionCron {
  export const Schedule = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("at"),
      at: z.string(),
    }),
    z.object({
      kind: z.literal("every"),
      everyMs: z.number().int().positive(),
      anchorMs: z.number().int().optional(),
    }),
    z.object({
      kind: z.literal("cron"),
      expr: z.string().min(1),
      tz: z.string().optional(),
    }),
  ])

  export const Job = z.object({
    id: Identifier.schema("cron"),
    name: z.string().min(1),
    prompt: z.string().min(1),
    schedule: Schedule,
    enabled: z.boolean(),
    reply: z.boolean().optional(),
    deleteAfterRun: z.boolean().optional(),
    sessionID: Identifier.schema("session").optional(),
    sessionKey: z.string().optional(),
    state: z.object({
      nextRunAt: z.number().optional(),
      runningAt: z.number().optional(),
      lastRunAt: z.number().optional(),
      lastStatus: z.enum(["ok", "error", "skipped"]).optional(),
      lastError: z.string().optional(),
    }),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
  })
  export type Job = z.infer<typeof Job>

  const Store = z.object({
    version: z.literal(1),
    jobs: Job.array(),
  })

  export const CreateInput = z.object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    schedule: Schedule,
    enabled: z.boolean().optional(),
    reply: z.boolean().optional(),
    deleteAfterRun: z.boolean().optional(),
    sessionID: Identifier.schema("session").optional(),
    sessionKey: z.string().optional(),
  })

  export const PatchInput = z.object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    schedule: Schedule.optional(),
    enabled: z.boolean().optional(),
    reply: z.boolean().optional(),
    deleteAfterRun: z.boolean().optional(),
    sessionID: Identifier.schema("session").nullable().optional(),
    sessionKey: z.string().nullable().optional(),
  })

  export const RunInput = z.object({
    id: Identifier.schema("cron"),
    mode: z.enum(["due", "force"]).optional(),
  })

  export const RunsInput = z.object({
    id: Identifier.schema("cron"),
    limit: z.number().int().min(1).max(5000).optional(),
  })

  export const RunEntry = z.object({
    ts: z.number(),
    jobID: Identifier.schema("cron"),
    status: z.enum(["ok", "error", "skipped"]),
    runAt: z.number(),
    duration: z.number(),
    nextRunAt: z.number().optional(),
    error: z.string().optional(),
  })
  export type RunEntry = z.infer<typeof RunEntry>

  export const RemoveInput = z.object({
    id: Identifier.schema("cron"),
  })

  export const ListInput = z
    .object({
      includeDisabled: z.boolean().optional(),
    })
    .optional()

  const stateValue = {
    loaded: false,
    jobs: [] as Job[],
    queue: Promise.resolve(),
    running: new Set<string>(),
    timer: undefined as ReturnType<typeof setInterval> | undefined,
  }

  function state() {
    return stateValue
  }

  function filepath() {
    return path.join(Instance.directory, ".opencode", "cron", "jobs.json")
  }

  function runfile(id: string) {
    return path.join(Instance.directory, ".opencode", "cron", "runs", `${id}.jsonl`)
  }

  async function load() {
    const parsed = await Bun.file(filepath())
      .json()
      .catch(() => undefined)
    const result = Store.safeParse(parsed)
    if (!result.success) return [] as Job[]
    return result.data.jobs
  }

  async function save(jobs: Job[]) {
    await fs.mkdir(path.dirname(filepath()), { recursive: true })
    await Bun.write(filepath(), JSON.stringify({ version: 1, jobs }, null, 2) + "\n")
  }

  async function appendRun(entry: RunEntry) {
    const file = runfile(entry.jobID)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8")
  }

  async function readRuns(id: string, limit = 200) {
    const file = runfile(id)
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    if (!text.trim()) return [] as RunEntry[]

    const output = [] as RunEntry[]
    const lines = text.split("\n")
    for (let i = lines.length - 1; i >= 0 && output.length < limit; i--) {
      const line = lines[i]?.trim()
      if (!line) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = RunEntry.safeParse(value)
      if (!parsed.success) continue
      if (parsed.data.jobID !== id) continue
      output.push(parsed.data)
    }
    return output.toReversed()
  }

  function computeNext(schedule: z.infer<typeof Schedule>, now: number) {
    if (schedule.kind === "at") {
      return parseAt(schedule.at)
    }
    if (schedule.kind === "every") {
      return nextEvery(schedule.everyMs, now, schedule.anchorMs)
    }
    return nextCron(schedule.expr, now, schedule.tz)
  }

  async function ensure() {
    const current = state()
    if (current.loaded) return
    current.jobs = await load().then((jobs) => {
      return jobs.map((job) => {
        const sessionKey = Session.normalizeKey(job.sessionKey)
        const nextRunAt =
          job.enabled && job.state.nextRunAt === undefined ? computeNext(job.schedule, Date.now()) : job.state.nextRunAt
        return {
          ...job,
          sessionKey,
          state: {
            ...job.state,
            nextRunAt,
            runningAt: undefined,
          },
        }
      })
    })
    current.loaded = true
  }

  function lock<T>(work: () => Promise<T>) {
    const current = state()
    const next = current.queue.then(work, work)
    current.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function due(job: Job, now: number, mode: "due" | "force") {
    if (!job.enabled) return false
    if (mode === "force") return true
    if (!job.state.nextRunAt) return false
    return now >= job.state.nextRunAt
  }

  async function resolve(job: Job) {
    if (job.sessionKey) {
      const byKey = await Session.getByKey(job.sessionKey).catch(() => undefined)
      if (byKey) return byKey
    }
    if (!job.sessionID) return
    return Session.get(SessionID.make(job.sessionID)).catch(() => undefined)
  }

  async function enqueue(job: Job) {
    const target = await resolve(job)
    if (!target) throw new Error(`session not found for cron job: ${job.id}`)

    const interactive = job.reply === true
    const messageID = interactive ? MessageID.ascending() : undefined
    const text = interactive
      ? [
          `[cron:${job.name}]`,
          "Execute this scheduled task now and return only the final result to the user.",
          "Do not ask for confirmation.",
          `Task: ${job.prompt}`,
        ].join("\n")
      : `[cron:${job.name}] ${job.prompt}`
    const send = (msgID?: MessageID, model?: { providerID: ProviderID; modelID: ModelID }) =>
      SessionPrompt.prompt({
        sessionID: target.id,
        messageID: msgID,
        model,
        noReply: !interactive,
        parts: [
          {
            type: "text",
            text,
            synthetic: interactive,
            ignored: false,
          },
        ],
      })

    const result = await send(messageID)
    if (interactive && result.info.role !== "assistant") {
      throw new Error(`cron job did not produce an assistant reply: ${job.id}`)
    }
    if (interactive && messageID) {
      await Session.removeMessage({
        sessionID: target.id,
        messageID,
      })
    }
  }

  export function init() {
    const current = state()
    if (current.timer) return
    const directory = Instance.directory
    current.timer = setInterval(() => {
      void Instance.provide({
        directory,
        fn: runDue,
      })
    }, tick)
  }

  export const status = fn(z.object({}).optional(), async () => {
    return lock(async () => {
      await ensure()
      const jobs = state().jobs.filter((item) => item.enabled)
      const next = jobs
        .map((item) => item.state.nextRunAt)
        .filter((item): item is number => typeof item === "number")
        .sort((a, b) => a - b)[0]
      return {
        enabled: true,
        jobs: state().jobs.length,
        nextWakeAt: next,
      }
    })
  })

  export const list = fn(ListInput, async (input) => {
    return lock(async () => {
      await ensure()
      const includeDisabled = input?.includeDisabled === true
      return state()
        .jobs.filter((item) => includeDisabled || item.enabled)
        .toSorted((a, b) => {
          const left = a.state.nextRunAt ?? Number.MAX_SAFE_INTEGER
          const right = b.state.nextRunAt ?? Number.MAX_SAFE_INTEGER
          return left - right
        })
    })
  })

  export const add = fn(CreateInput, async (input) => {
    return lock(async () => {
      await ensure()

      const now = Date.now()
      const enabled = input.enabled ?? true
      const key = Session.normalizeKey(input.sessionKey)
      if (!input.sessionID && !key) {
        throw new Error("cron job requires sessionID or sessionKey")
      }

      const nextRunAt = enabled ? computeNext(input.schedule, now) : undefined
      if (enabled && nextRunAt === undefined) {
        throw new Error("invalid cron schedule")
      }

      const job: Job = {
        id: Identifier.ascending("cron"),
        name: input.name.trim(),
        prompt: input.prompt.trim(),
        schedule: input.schedule,
        enabled,
        reply: input.reply,
        deleteAfterRun: input.deleteAfterRun ?? (input.schedule.kind === "at" ? true : undefined),
        sessionID: input.sessionID,
        sessionKey: key,
        state: {
          nextRunAt,
        },
        time: {
          created: now,
          updated: now,
        },
      }

      state().jobs.push(job)
      await save(state().jobs)
      return job
    })
  })

  export const update = fn(
    z.object({
      id: Identifier.schema("cron"),
      patch: PatchInput,
    }),
    async (input) => {
      return lock(async () => {
        await ensure()
        const idx = state().jobs.findIndex((item) => item.id === input.id)
        if (idx < 0) throw new Error(`unknown cron job id: ${input.id}`)

        const prev = state().jobs[idx]
        const now = Date.now()
        const patch = input.patch
        const schedule = patch.schedule ?? prev.schedule
        const enabled = patch.enabled ?? prev.enabled
        const sessionID =
          patch.sessionID === undefined ? prev.sessionID : patch.sessionID === null ? undefined : patch.sessionID
        const sessionKey =
          patch.sessionKey === undefined
            ? prev.sessionKey
            : patch.sessionKey === null
              ? undefined
              : Session.normalizeKey(patch.sessionKey)

        const nextRunAt = enabled ? computeNext(schedule, now) : undefined
        if (enabled && nextRunAt === undefined) {
          throw new Error("invalid cron schedule")
        }

        const next: Job = {
          ...prev,
          name: patch.name?.trim() ?? prev.name,
          prompt: patch.prompt?.trim() ?? prev.prompt,
          schedule,
          enabled,
          reply: patch.reply ?? prev.reply,
          deleteAfterRun: patch.deleteAfterRun ?? prev.deleteAfterRun,
          sessionID,
          sessionKey,
          state: {
            ...prev.state,
            nextRunAt,
            runningAt: undefined,
          },
          time: {
            ...prev.time,
            updated: now,
          },
        }

        state().jobs[idx] = next
        await save(state().jobs)
        return next
      })
    },
  )

  export const remove = fn(RemoveInput, async (input) => {
    return lock(async () => {
      await ensure()
      const before = state().jobs.length
      state().jobs = state().jobs.filter((item) => item.id !== input.id)
      const removed = state().jobs.length !== before
      if (removed) await save(state().jobs)
      return {
        ok: true,
        removed,
      }
    })
  })

  export const run = fn(RunInput, async (input) => {
    return lock(async () => {
      await ensure()
      const now = Date.now()
      const job = state().jobs.find((item) => item.id === input.id)
      if (!job) throw new Error(`unknown cron job id: ${input.id}`)
      if (state().running.has(job.id)) {
        return {
          ok: true,
          ran: false,
          reason: "already-running",
        } as const
      }

      const mode = input.mode ?? "force"
      if (!due(job, now, mode)) {
        return {
          ok: true,
          ran: false,
          reason: "not-due",
        } as const
      }

      state().running.add(job.id)
      job.state.runningAt = now
      job.time.updated = now
      await save(state().jobs)

      const result = await enqueue(job).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error: `${error}` }),
      )

      const done = Date.now()
      state().running.delete(job.id)

      const idx = state().jobs.findIndex((item) => item.id === job.id)
      const current = idx >= 0 ? state().jobs[idx] : undefined
      if (!current) {
        await appendRun({
          ts: done,
          jobID: job.id,
          status: result.ok ? "ok" : "error",
          runAt: now,
          duration: done - now,
          error: result.ok ? undefined : result.error,
        })
        return {
          ok: result.ok,
          ran: true,
          status: result.ok ? "ok" : "error",
        } as const
      }

      current.state.runningAt = undefined
      current.state.lastRunAt = done
      current.state.lastStatus = result.ok ? "ok" : "error"
      current.state.lastError = result.ok ? undefined : result.error
      current.time.updated = done

      const oneShot = current.schedule.kind === "at"
      if (result.ok && oneShot && current.deleteAfterRun !== false) {
        state().jobs.splice(idx, 1)
        await save(state().jobs)
        await appendRun({
          ts: done,
          jobID: current.id,
          status: "ok",
          runAt: now,
          duration: done - now,
        })
        return {
          ok: true,
          ran: true,
          status: "ok",
          removed: true,
        } as const
      }

      if (oneShot) {
        current.enabled = false
        current.state.nextRunAt = undefined
      } else {
        current.state.nextRunAt = current.enabled ? computeNext(current.schedule, done) : undefined
      }

      await save(state().jobs)
      await appendRun({
        ts: done,
        jobID: current.id,
        status: result.ok ? "ok" : "error",
        runAt: now,
        duration: done - now,
        nextRunAt: current.state.nextRunAt,
        error: result.ok ? undefined : result.error,
      })
      return {
        ok: result.ok,
        ran: true,
        status: result.ok ? "ok" : "error",
      } as const
    })
  })

  export async function runDue() {
    const ids = await lock(async () => {
      await ensure()
      const now = Date.now()
      return state()
        .jobs.filter((item) => due(item, now, "due") && !state().running.has(item.id))
        .sort((a, b) => (a.state.nextRunAt ?? 0) - (b.state.nextRunAt ?? 0))
        .map((item) => item.id)
    })

    const output = [] as Awaited<ReturnType<typeof run>>[]
    for (const id of ids) {
      output.push(await run({ id, mode: "due" }))
    }
    return output
  }

  export const runs = fn(RunsInput, async (input) => {
    return lock(async () => {
      await ensure()
      return readRuns(input.id, input.limit ?? 200)
    })
  })
}
