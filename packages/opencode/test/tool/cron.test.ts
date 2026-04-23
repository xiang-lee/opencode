import { describe, expect, test } from "bun:test"
import { CronTool } from "../../src/tool/cron"

describe("tool.cron", () => {
  test("is registered with the expected id", () => {
    expect(CronTool.id).toBe("cron")
  })
})
