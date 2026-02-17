import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionMemory } from "../../src/session/memory"
import { SessionPrompt } from "../../src/session/prompt"
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
  test("creates workspace memory templates per project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changed = await SessionMemory.ensure({ directory: tmp.path })
        const files = SessionMemory.workspace(tmp.path)
        const soul = await Bun.file(files.soul).text()
        const tools = await Bun.file(files.tools).text()
        const identity = await Bun.file(files.identity).text()
        const user = await Bun.file(files.user).text()
        const heartbeat = await Bun.file(files.heartbeat).text()
        const boot = await Bun.file(files.boot).text()
        const bootstrap = await Bun.file(files.bootstrap).text()

        expect(changed).toBe(true)
        expect(soul).toContain("# SOUL.md")
        expect(tools).toContain("# TOOLS.md")
        expect(identity).toContain("# IDENTITY.md")
        expect(user).toContain("# USER.md")
        expect(heartbeat).toContain("# HEARTBEAT.md")
        expect(boot).toContain("# BOOT.md")
        expect(bootstrap).toContain("# BOOTSTRAP.md")

        const unchanged = await SessionMemory.ensure({ directory: tmp.path })
        expect(unchanged).toBe(false)
      },
    })
  })

  test("writes memory files and loads them into system context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "main" })
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
        const daily = SessionMemory.daily(session.directory)
        const log = await Bun.file(daily.today).text()
        const system = await SessionMemory.system({
          id: session.id,
          key: session.key,
          directory: session.directory,
        })
        const files = SessionMemory.workspace(session.directory)

        expect(memory).toContain("Last user request")
        expect(user).toContain("Inferred preferences")
        expect(key).toContain("Recent user intent")
        expect(log).toContain("- User:")
        expect(system.some((item) => item.includes("Memory from: "))).toBe(true)
        expect(system.some((item) => item.includes(files.soul))).toBe(true)
        expect(system.some((item) => item.includes(files.tools))).toBe(true)
        expect(system.some((item) => item.includes(files.identity))).toBe(true)
        expect(system.some((item) => item.includes(file.memory))).toBe(true)
      },
    })
  })

  test("does not inject MEMORY.md for non-main sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await Session.create({ key: "main" })
        await push(main.id, tmp.path, "Remember I like concise replies", "Got it")
        await SessionMemory.update({
          session: {
            id: main.id,
            key: main.key,
            directory: main.directory,
          },
          messages: await Session.messages({ sessionID: main.id }),
        })

        const side = await Session.create({ key: "alpha" })
        const system = await SessionMemory.system({
          id: side.id,
          key: side.key,
          directory: side.directory,
        })
        const file = SessionMemory.paths({
          id: side.id,
          key: side.key,
          directory: side.directory,
        })

        expect(system.some((item) => item.includes(file.memory))).toBe(false)
      },
    })
  })

  test("is idempotent for the same heartbeat marker", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ key: "main" })
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

  test("updates USER.md and IDENTITY.md from explicit naming", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SessionMemory.ensure({ directory: tmp.path })
        const session = await Session.create({ key: "main" })
        await push(session.id, tmp.path, "你叫Luffy, 我叫Xiang", "收到")
        await SessionMemory.update({
          session: {
            id: session.id,
            key: session.key,
            directory: session.directory,
          },
          messages: await Session.messages({ sessionID: session.id }),
        })

        const file = SessionMemory.workspace(session.directory)
        const user = await Bun.file(file.user).text()
        const identity = await Bun.file(file.identity).text()
        const bootstrap = await Bun.file(file.bootstrap).exists()
        const done = await Bun.file(file.bootstrapDone).exists()

        expect(user).toContain("- Name: Xiang")
        expect(user).toContain("- What to call them: Xiang")
        expect(identity).toContain("- Name: Luffy")
        expect(bootstrap).toBe(false)
        expect(done).toBe(true)
      },
    })
  })

  test("syncs profile memory during prompt without waiting for heartbeat", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SessionMemory.ensure({ directory: tmp.path })
        const session = await Session.create({ key: "main" })

        await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "你叫Luffy, 我叫Xiang",
            },
          ],
        })

        const file = SessionMemory.workspace(tmp.path)
        const user = await Bun.file(file.user).text()
        const identity = await Bun.file(file.identity).text()

        expect(user).toContain("- Name: Xiang")
        expect(user).toContain("- What to call them: Xiang")
        expect(identity).toContain("- Name: Luffy")
      },
    })
  })
})
