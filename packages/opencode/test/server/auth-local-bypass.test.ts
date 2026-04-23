import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"

const originalPassword = process.env["OPENCODE_SERVER_PASSWORD"]
const originalUsername = process.env["OPENCODE_SERVER_USERNAME"]

afterEach(async () => {
  if (originalPassword === undefined) delete process.env["OPENCODE_SERVER_PASSWORD"]
  else process.env["OPENCODE_SERVER_PASSWORD"] = originalPassword

  if (originalUsername === undefined) delete process.env["OPENCODE_SERVER_USERNAME"]
  else process.env["OPENCODE_SERVER_USERNAME"] = originalUsername

  await Instance.disposeAll()
})

describe("server basic auth localhost bypass", () => {
  test("allows localhost tunnel hosts without auth", async () => {
    process.env["OPENCODE_SERVER_PASSWORD"] = "test-password"
    delete process.env["OPENCODE_SERVER_USERNAME"]

    const { app } = Server.Default()

    for (const host of ["127.0.0.1:18080", "localhost:18080", "[::1]:18080"]) {
      const res = await app.request("/global/health", {
        headers: { Host: host },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ healthy: true, version: expect.any(String) })
    }
  })

  test("keeps public hosts behind basic auth", async () => {
    process.env["OPENCODE_SERVER_PASSWORD"] = "test-password"
    process.env["OPENCODE_SERVER_USERNAME"] = "opencode"

    const { app } = Server.Default()

    const rejected = await app.request("/global/health", {
      headers: { Host: "example.com" },
    })
    expect(rejected.status).toBe(401)

    const accepted = await app.request("/global/health", {
      headers: {
        Host: "example.com",
        Authorization: `Basic ${Buffer.from("opencode:test-password").toString("base64")}`,
      },
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ healthy: true, version: expect.any(String) })
  })
})
