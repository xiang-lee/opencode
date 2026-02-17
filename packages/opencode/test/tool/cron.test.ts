import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { CronTool } from "../../src/tool/cron"
import { tmpdir } from "../fixture/fixture"

describe("tool.cron", () => {
  test("supports add, run, and runs actions end-to-end", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "ops" })
        const tool = await CronTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "msg_test",
          callID: "call_test",
          agent: "default",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }

        const added = await tool.execute(
          {
            action: "add",
            job: {
              name: "E2E",
              prompt: "Collect e2e note",
              sessionID: session.id,
              schedule: {
                kind: "at",
                at: new Date(Date.now() - 1_000).toISOString(),
              },
            },
          },
          ctx,
        )

        const job = JSON.parse(added.output) as { id: string }
        const run = await tool.execute(
          {
            action: "run",
            jobId: job.id,
            mode: "force",
          },
          ctx,
        )
        const runs = await tool.execute(
          {
            action: "runs",
            jobId: job.id,
          },
          ctx,
        )

        const runData = JSON.parse(run.output) as { ran: boolean; status: string }
        const runsData = JSON.parse(runs.output) as {
          entries: Array<{ jobID: string; status: string }>
        }

        expect(runData.ran).toBe(true)
        expect(runData.status).toBe("ok")
        expect(runsData.entries.length).toBe(1)
        expect(runsData.entries[0]?.jobID).toBe(job.id)
        expect(runsData.entries[0]?.status).toBe("ok")
      },
    })
  })
})
