import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"

export namespace CloudStore {
  const base = path.join(Global.Path.data, "cloud", "session")

  const file = (sessionID: string) => path.join(base, sessionID + ".json")

  async function read(sessionID: string) {
    return Bun.file(file(sessionID))
      .json()
      .catch(() => undefined)
  }

  export async function mark(sessionID: string) {
    await fs.mkdir(base, { recursive: true })
    await Bun.write(file(sessionID), JSON.stringify({ cloud: true, updated: Date.now() }, null, 2))
  }

  export async function unmark(sessionID: string) {
    await fs.unlink(file(sessionID)).catch(() => {})
  }

  export async function status(sessionID: string) {
    const data = await read(sessionID)
    return {
      cloud: data?.cloud === true,
    }
  }
}
