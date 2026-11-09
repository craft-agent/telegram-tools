import { callService } from "../telegram/service"
import { SERVICE_REQUESTS, type DownloadParams, type DownloadResult } from "../telegram/service-requests"

/** How long a download may take: Telegram takes files of several gigabytes, and the service ends a download that receives nothing for 60 seconds. */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/**
 * One message's file taken from Telegram into a folder of the label's
 * `incoming/`, or the reason the service refused it. A download changes
 * nothing at Telegram, so it is a read: a cancelled call is an `AbortError`.
 */
export function requestDownload(socket: string, params: DownloadParams, signal?: AbortSignal): Promise<DownloadResult> {
  return callService<DownloadResult>(socket, SERVICE_REQUESTS.download, params, {
    effect: "read",
    signal,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  })
}
