/** Every tool reads labels and the mirror through this module. */
import { ToolError } from "./errors"
import { pickLabel, type LabelPaths } from "./telegram/labels"
import { openMirrorForRead, type Mirror } from "./telegram/mirror"
import type { ToolContext } from "./tool"

/** The paths of the account `account` picks (see `pickLabel`). */
export async function pickPaths(ctx: Pick<ToolContext, "stateDir">, account: string | undefined): Promise<LabelPaths> {
  if (!ctx.stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
  return pickLabel(ctx.stateDir, account)
}

/**
 * Runs `read` on the mirror at `paths`, opened read-only. All of `read` runs in
 * one read transaction, so what it reads belongs to one moment. The mirror is
 * closed afterwards, whatever `read` does. A call that goes to the service
 * between two reads closes the mirror before it, so no transaction is held
 * open across the wait.
 */
export function readMirror<T>(paths: Pick<LabelPaths, "mirror">, read: (mirror: Mirror) => T): T {
  const mirror = openMirrorForRead(paths.mirror)
  try {
    // One deferred read transaction: every query of the call sees the same moment, however the service writes meanwhile.
    mirror.exec("BEGIN")
    try {
      return read(mirror)
    } finally {
      if (mirror.isTransaction) mirror.exec("ROLLBACK")
    }
  } finally {
    mirror.close()
  }
}
