import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCron } from "../../src/session/cron"
import { tmpdir } from "../fixture/fixture"

describe("session cron", () => {
  test("adds, lists, and removes jobs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "ops" })
        const job = await SessionCron.add({
          name: "Ping",
          prompt: "Check queue",
          sessionID: session.id,
          schedule: {
            kind: "every",
            everyMs: 60_000,
          },
        })

        const status = await SessionCron.status({})
        const listed = await SessionCron.list({ includeDisabled: true })
        const removed = await SessionCron.remove({ id: job.id })
        const after = await SessionCron.list({ includeDisabled: true })

        expect(status.jobs).toBe(1)
        expect(listed.length).toBe(1)
        expect(removed.removed).toBe(true)
        expect(after.length).toBe(0)
      },
    })
  })

  test("runs due one-shot jobs and appends reminder message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "alpha" })
        const when = new Date(Date.now() - 5_000).toISOString()

        const job = await SessionCron.add({
          name: "Reminder",
          prompt: "Please review deployment checklist",
          sessionKey: session.key,
          schedule: {
            kind: "at",
            at: when,
          },
        })

        const run = await SessionCron.run({ id: job.id, mode: "due" })
        const listed = await SessionCron.list({ includeDisabled: true })
        const messages = await Session.messages({ sessionID: session.id })
        const tail = messages[messages.length - 1]
        const text = tail?.parts.find((part) => part.type === "text")?.text ?? ""

        expect(run.ran).toBe(true)
        expect(run.status).toBe("ok")
        expect(listed.length).toBe(0)
        expect(tail?.info.role).toBe("user")
        expect(text).toContain("[cron:Reminder]")
        expect(text).toContain("Please review deployment checklist")
      },
    })
  })

  test("supports forced runs for recurring jobs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const job = await SessionCron.add({
          name: "Warmup",
          prompt: "Collect daily notes",
          sessionID: session.id,
          schedule: {
            kind: "every",
            everyMs: 60_000,
          },
        })

        const due = await SessionCron.run({ id: job.id, mode: "due" })
        const forced = await SessionCron.run({ id: job.id, mode: "force" })
        const listed = await SessionCron.list({ includeDisabled: true })
        const current = listed.find((item) => item.id === job.id)

        expect(due.ran).toBe(false)
        expect(forced.ran).toBe(true)
        expect(current?.enabled).toBe(true)
        expect(typeof current?.state.nextRunAt).toBe("number")
        expect((current?.state.nextRunAt ?? 0) > Date.now()).toBe(true)
      },
    })
  })

  test("stores run history for successful jobs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const job = await SessionCron.add({
          name: "History",
          prompt: "Write history marker",
          sessionID: session.id,
          schedule: {
            kind: "every",
            everyMs: 60_000,
          },
        })

        const run = await SessionCron.run({ id: job.id, mode: "force" })
        const entries = await SessionCron.runs({ id: job.id })
        const last = entries[entries.length - 1]

        expect(run.ran).toBe(true)
        expect(entries.length).toBe(1)
        expect(last?.status).toBe("ok")
        expect(last?.jobID).toBe(job.id)
        expect((last?.duration ?? 0) >= 0).toBe(true)
      },
    })
  })

  test("stores run history for failed jobs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const job = await SessionCron.add({
          name: "Missing",
          prompt: "Will fail",
          sessionKey: "missing-session",
          schedule: {
            kind: "every",
            everyMs: 60_000,
          },
        })

        const run = await SessionCron.run({ id: job.id, mode: "force" })
        const entries = await SessionCron.runs({ id: job.id })
        const last = entries[entries.length - 1]

        expect(run.ran).toBe(true)
        expect(run.status).toBe("error")
        expect(entries.length).toBe(1)
        expect(last?.status).toBe("error")
        expect(last?.error).toContain("session not found")
      },
    })
  })
})
