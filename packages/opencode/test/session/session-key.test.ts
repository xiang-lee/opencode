import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("session key", () => {
  test("reuses session for the same normalized key", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = await Session.create({ key: " Product/Alpha " })
        const two = await Session.create({ key: "product/alpha" })
        const three = await Session.getByKey("PRODUCT/ALPHA")

        expect(one.id).toBe(two.id)
        expect(one.id).toBe(three.id)
        expect(one.key).toBe("product/alpha")
      },
    })
  })

  test("filters list by key", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = await Session.create({ key: "foo" })
        await Session.create({ key: "bar" })
        await Session.create({})

        const list = [...Session.list({ key: "FOO" })]

        expect(list.length).toBe(1)
        expect(list[0]?.id).toBe(one.id)
      },
    })
  })
})
