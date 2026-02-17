import z from "zod"
import { Tool } from "./tool"
import { SessionCron } from "@/session/cron"
import { Identifier } from "@/id/id"
import { Session } from "@/session"

const actions = ["status", "list", "add", "update", "remove", "run", "runs"] as const

const params = z.object({
  action: z.enum(actions),
  includeDisabled: z.boolean().optional(),
  job: SessionCron.CreateInput.optional(),
  jobId: Identifier.schema("cron").optional(),
  patch: SessionCron.PatchInput.optional(),
  mode: z.enum(["due", "force"]).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
})

const description = `Manage scheduled cron-style jobs for this project.

Actions:
- status: show scheduler status and next wake time
- list: list jobs (set includeDisabled=true to include disabled jobs)
- add: create a new job (requires job)
- update: update an existing job (requires jobId and patch)
- remove: remove a job (requires jobId)
- run: run a job now (requires jobId, optional mode=force|due)
- runs: fetch execution history for a job (requires jobId, optional limit)

Job schedule kinds:
- at: { kind: "at", at: "2026-02-17T18:00:00Z" }
- every: { kind: "every", everyMs: 3600000, anchorMs?: 1739836800000 }
- cron: { kind: "cron", expr: "0 9 * * 1-5", tz?: "America/Los_Angeles" }

Job execution:
- reply omitted/false: append a scheduled user message to the target session
- reply=true: append the scheduled message and immediately run the assistant turn

By default, add uses the current session as the target.`

export const CronTool = Tool.define("cron", {
  description,
  parameters: params,
  async execute(input, ctx) {
    function reply(title: string, metadata: Record<string, unknown>, output: string) {
      return {
        title,
        metadata,
        output,
      }
    }

    await ctx.ask({
      permission: "cron",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        action: input.action,
      },
    })

    if (input.action === "status") {
      const output = await SessionCron.status({})
      return reply("cron status", output as Record<string, unknown>, JSON.stringify(output, null, 2))
    }

    if (input.action === "list") {
      const jobs = await SessionCron.list({ includeDisabled: input.includeDisabled })
      return reply(`${jobs.length} cron jobs`, { jobs }, JSON.stringify({ jobs }, null, 2))
    }

    if (input.action === "add") {
      if (!input.job) throw new Error("job is required for action=add")
      const current = await Session.get(ctx.sessionID)
      const job = await SessionCron.add({
        ...input.job,
        sessionID: input.job.sessionID ?? current.id,
        sessionKey: input.job.sessionKey ?? current.key,
      })
      return reply(`cron ${job.name}`, { job }, JSON.stringify(job, null, 2))
    }

    if (input.action === "update") {
      if (!input.jobId) throw new Error("jobId is required for action=update")
      if (!input.patch) throw new Error("patch is required for action=update")
      const job = await SessionCron.update({
        id: input.jobId,
        patch: input.patch,
      })
      return reply(`cron ${job.name}`, { job }, JSON.stringify(job, null, 2))
    }

    if (input.action === "remove") {
      if (!input.jobId) throw new Error("jobId is required for action=remove")
      const result = await SessionCron.remove({ id: input.jobId })
      return reply("cron remove", result as Record<string, unknown>, JSON.stringify(result, null, 2))
    }

    if (input.action === "run") {
      if (!input.jobId) throw new Error("jobId is required for action=run")
      const result = await SessionCron.run({
        id: input.jobId,
        mode: input.mode,
      })
      return reply("cron run", result as Record<string, unknown>, JSON.stringify(result, null, 2))
    }

    if (!input.jobId) throw new Error("jobId is required for action=runs")
    const entries = await SessionCron.runs({
      id: input.jobId,
      limit: input.limit,
    })
    return reply("cron runs", { entries }, JSON.stringify({ entries }, null, 2))
  },
})
