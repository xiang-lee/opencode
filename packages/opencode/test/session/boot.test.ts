import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionBoot } from "../../src/session/boot"
import { SessionMemory } from "../../src/session/memory"
import { tmpdir } from "../fixture/fixture"

describe("session boot", () => {
  test("removes BOOTSTRAP.md after identity and user are filled", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SessionMemory.ensure({ directory: tmp.path })
        const file = SessionMemory.workspace(tmp.path)
        const before = await Bun.file(file.bootstrap).exists()

        await Bun.write(
          file.identity,
          ["# IDENTITY.md - Who Am I?", "", "- Name: Clawd", "- Role: coding assistant"].join("\n"),
        )
        await Bun.write(file.user, ["# USER.md - About Your Human", "", "- What to call them: Xiang"].join("\n"))

        await SessionBoot.run()

        const after = await Bun.file(file.bootstrap).exists()
        const done = await Bun.file(file.bootstrapDone).exists()
        await SessionMemory.ensure({ directory: tmp.path })
        const recreated = await Bun.file(file.bootstrap).exists()
        expect(before).toBe(true)
        expect(after).toBe(false)
        expect(done).toBe(true)
        expect(recreated).toBe(false)
      },
    })
  })

  test("reads BOOT.md and appends startup checklist prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SessionMemory.ensure({ directory: tmp.path })
        const file = SessionMemory.workspace(tmp.path)
        await Bun.write(file.boot, ["@reply false", "- Check git status", "- Review memory notes"].join("\n"))

        const session = await Session.create({ key: "main" })
        const ok = await SessionBoot.run()
        const messages = await Session.messages({ sessionID: session.id })
        const text = messages[0]?.parts.find((item) => item.type === "text")

        expect(ok).toBe(true)
        expect(messages.length).toBe(1)
        expect(messages[0]?.info.role).toBe("user")
        expect(text?.text).toContain("[boot]")
        expect(text?.text).toContain("Check git status")
        expect(text?.text).toContain("NO_REPLY")
      },
    })
  })
})
