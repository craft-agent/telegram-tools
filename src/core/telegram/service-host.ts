import { ToolError } from "../errors"
import {
  installLaunchdService,
  launchdServiceStatus,
  removeLaunchdServiceLog,
  uninstallLaunchdService,
} from "./service-launchd"
import { installSystemdService, systemdServiceStatus, uninstallSystemdService } from "./service-systemd"
import {
  defaultServiceHost,
  type ServiceHost,
  type ServiceName,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

export type { ServiceHost, ServiceName, ServiceSpec, ServiceStatus }
export { defaultServiceHost }

const UNSUPPORTED_PLATFORM = "Running the sync service is supported on macOS and Linux only."

function checkPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new ToolError("invalid_argument", UNSUPPORTED_PLATFORM)
  }
}

/**
 * The directory the platform's service manager starts the service in: `/` for
 * a launchd agent, the user's home for a systemd user unit. A program found on
 * the `PATH` can resolve differently from one directory to another, so
 * anything checked for the service must be checked from this directory.
 * Refuses on other platforms.
 */
export function serviceWorkingDirectory(host: ServiceHost = defaultServiceHost()): string {
  checkPlatform(host.platform)
  return host.platform === "darwin" ? "/" : host.home
}

/**
 * Installs and enables the background sync service for one label.
 *
 * Supported on macOS (launchd agent) and Linux (systemd user unit).
 * Refuses on other platforms.
 */
export async function installService(
  spec: ServiceSpec,
  host: ServiceHost = defaultServiceHost(),
): Promise<{ file: string; log?: string }> {
  checkPlatform(host.platform)
  if (host.platform === "darwin") {
    return installLaunchdService(spec, host)
  }
  return installSystemdService(spec, host)
}

/**
 * Stops, disables, and deletes the sync service for one label. On macOS the
 * launcher script goes too, and its directory once empty.
 *
 * Missing or already-uninstalled services complete without error.
 */
export async function uninstallService(
  name: ServiceName,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<void> {
  checkPlatform(host.platform)
  if (host.platform === "darwin") {
    return uninstallLaunchdService(name, label, host)
  }
  return uninstallSystemdService(name.id, label, host)
}

/**
 * Deletes the sync service's log for one label.
 *
 * Only macOS keeps a log file per label; Linux logs to the user journal, which
 * cannot be pruned per unit, and other platforms never had a service, so there
 * the call does nothing.
 */
export async function removeServiceLog(
  id: string,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<void> {
  if (host.platform === "darwin") {
    await removeLaunchdServiceLog(id, label, host)
  }
}

/**
 * Queries the current installation and execution status of the sync service.
 */
export async function serviceStatus(
  id: string,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<ServiceStatus> {
  checkPlatform(host.platform)
  if (host.platform === "darwin") {
    return launchdServiceStatus(id, label, host)
  }
  return systemdServiceStatus(id, label, host)
}
