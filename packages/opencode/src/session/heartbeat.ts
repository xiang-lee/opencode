import { Log } from "@/util/log"
import { Scheduler } from "@/scheduler"
import { Session } from "."
import { SessionMemory } from "./memory"
import { Instance } from "@/project/instance"

export namespace SessionHeartbeat {
  const log = Log.create({ service: "session.heartbeat" })
  const minute = 60 * 1000

  const state = Instance.state(() => {
    return {
      seen: new Map<string, string>(),
    }
  })

  export function init() {
    Scheduler.register({
      id: "session.memory.heartbeat",
      interval: minute,
      run,
      scope: "instance",
    })
  }

  export async function run() {
    const sessions = [...Session.list({ limit: 50 })].filter((item) => !!item.key && !item.time.archived)
    for (const item of sessions) {
      await sync(item)
    }
  }

  export async function sync(session: Session.Info) {
    if (!session.key) return false
    const messages = await Session.messages({
      sessionID: session.id,
      limit: 48,
    })
    const tail = messages[messages.length - 1]?.info.id
    if (!tail) return false
    if (state().seen.get(session.id) === tail) return false
    const changed = await SessionMemory.update({
      session: {
        id: session.id,
        key: session.key,
        directory: session.directory,
      },
      messages,
    })
    state().seen.set(session.id, tail)
    if (changed) {
      log.info("updated", {
        sessionID: session.id,
        key: session.key,
      })
    }
    return changed
  }
}
