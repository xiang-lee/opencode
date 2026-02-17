import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
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

describe("session memory", () => {
  test("writes memory files and loads them into system context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "alpha" })
        await push(session.id, tmp.path, "Please remember I prefer Bun scripts", "Saved. I will prefer Bun.")
        const messages = await Session.messages({ sessionID: session.id })
        const updated = await SessionMemory.update({
          session: {
            id: session.id,
            key: session.key,
            directory: session.directory,
          },
          messages,
        })

        expect(updated).toBe(true)
        const file = SessionMemory.paths({
          id: session.id,
          key: session.key,
          directory: session.directory,
        })
        const memory = await Bun.file(file.memory).text()
        const user = await Bun.file(file.user).text()
        const key = await Bun.file(file.session!).text()
        const system = await SessionMemory.system({
          id: session.id,
          key: session.key,
          directory: session.directory,
        })

        expect(memory).toContain("Last user request")
        expect(user).toContain("Inferred preferences")
        expect(key).toContain("Recent user intent")
        expect(system.some((item) => item.includes("Memory from: "))).toBe(true)
      },
    })
  })

  test("is idempotent for the same heartbeat marker", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "beta" })
        await push(session.id, tmp.path, "Remember: never use npm here", "Understood.")
        const messages = await Session.messages({ sessionID: session.id })
        const tail = messages[messages.length - 1]!.info.id

        await SessionMemory.update({
          session: {
            id: session.id,
            key: session.key,
            directory: session.directory,
          },
          messages,
        })
        await SessionMemory.update({
          session: {
            id: session.id,
            key: session.key,
            directory: session.directory,
          },
          messages,
        })

        const file = SessionMemory.paths({
          id: session.id,
          key: session.key,
          directory: session.directory,
        })
        const memory = await Bun.file(file.memory).text()
        const count = memory.split("<!-- hb:" + tail + " -->").length - 1

        expect(count).toBe(1)
      },
    })
  })
})
