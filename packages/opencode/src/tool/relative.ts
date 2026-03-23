import path from "path"
import { Instance } from "../project/instance"

export function relative(file: string) {
  const root = Instance.worktree === "/" ? Instance.directory : Instance.worktree
  return path.relative(root, file)
}
