import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionHeartbeat } from "../../src/session/heartbeat"
import { SessionMemory } from "../../src/session/memory"
import { tmpdir } from "../fixture/fixture"

async function push(sessionID: SessionID, dir: string, user: string, assistant: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(Identifier.ascending("message")),
    role: "user",
    sessionID,
    agent: "default",
    model: {
      providerID: "openai",
      modelID: "gpt-4",
    },
    time: {
      created: Date.now(),
    },
  })
  await Session.updatePart({
    id: PartID.ascending(Identifier.ascending("part")),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: user,
  })

  const answer: MessageV2.Assistant = {
    id: MessageID.ascending(Identifier.ascending("message")),
    role: "assistant",
    sessionID,
    mode: "default",
    agent: "default",
    path: {
      cwd: dir,
      root: dir,
    },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: msg.id,
    time: {
      created: Date.now(),
    },
    finish: "end_turn",
  }
  await Session.updateMessage(answer)
  await Session.updatePart({
    id: PartID.ascending(Identifier.ascending("part")),
    messageID: answer.id,
    sessionID,
    type: "text",
    text: assistant,
  })
}

describe("session heartbeat", () => {
  test("parses HEARTBEAT.md tasks and directives", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SessionMemory.ensure({ directory: tmp.path })
        const file = SessionMemory.workspace(tmp.path).heartbeat
        await Bun.write(
          file,
          [
            "# comment",
            "@every 2m",
            "@retry 10m",
            "@quiet 23:00-08:00",
            "@reply false",
            "",
            "- Check inbox",
            "  ",
            "# another",
            "Review deploy checklist",
          ].join("\n"),
        )

        const plan = await SessionHeartbeat.plan(tmp.path)
        const tasks = await SessionHeartbeat.tasks(tmp.path)
        expect(tasks).toEqual(["Check inbox", "Review deploy checklist"])
        expect(plan.reply).toBe(false)
        expect(plan.every).toBe(2 * 60 * 1000)
        expect(plan.retry).toBe(10 * 60 * 1000)
        expect(plan.quiet).toEqual({
          start: 23 * 60,
          end: 8 * 60,
        })
      },
    })
  })

  test("adds periodic heartbeat prompt with cooldown", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SessionMemory.ensure({ directory: tmp.path })
        await Bun.write(
          SessionMemory.workspace(tmp.path).heartbeat,
          ["@every 1m", "@reply false", "- Check urgent TODOs"].join("\n"),
        )

        const session = await Session.create({ key: "main" })
        const before = await Session.messages({ sessionID: session.id })

        await SessionHeartbeat.run()
        const one = await Session.messages({ sessionID: session.id })
        await SessionHeartbeat.run()
        const two = await Session.messages({ sessionID: session.id })

        expect(before.length).toBe(0)
        expect(one.length).toBe(1)
        expect(two.length).toBe(1)
        expect(one[0]?.info.role).toBe("user")
        const text = one[0]?.parts.find((item) => item.type === "text")
        expect(text?.text).toContain("[heartbeat]")
        expect(text?.text).toContain("HEARTBEAT_OK")
        expect(text?.text).toContain("Check urgent TODOs")
      },
    })
  })

  test("only writes memory when new messages are present", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "main" })
        await push(session.id, tmp.path, "Please remember this is production", "Will do.")
        const one = await SessionHeartbeat.sync(session)
        const two = await SessionHeartbeat.sync(session)
        await push(session.id, tmp.path, "Prefer Bun for scripts", "Acknowledged.")
        const three = await SessionHeartbeat.sync(session)

        expect(one).toBe(true)
        expect(two).toBe(false)
        expect(three).toBe(true)

        const file = SessionMemory.paths({
          id: session.id,
          key: session.key,
          directory: session.directory,
        })
        const memory = await Bun.file(file.memory).text()
        const count = memory.split("<!-- hb:").length - 1
        expect(count).toBe(2)
      },
    })
  })
})
