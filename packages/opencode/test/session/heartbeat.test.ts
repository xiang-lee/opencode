import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionHeartbeat } from "../../src/session/heartbeat"
import { SessionMemory } from "../../src/session/memory"
import { tmpdir } from "../fixture/fixture"

async function push(sessionID: string, dir: string, user: string, assistant: string) {
  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
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
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: user,
  })

  const answer: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
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
    id: Identifier.ascending("part"),
    messageID: answer.id,
    sessionID,
    type: "text",
    text: assistant,
  })
}

describe("session heartbeat", () => {
  test("only writes memory when new messages are present", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "ops" })
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
