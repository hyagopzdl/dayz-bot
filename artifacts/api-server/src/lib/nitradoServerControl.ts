import { getServerNitradoConfig } from "./serverNitrado";
import { getNitradoGameserverStatus } from "./nitradoDownloader";

const STOP_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;

function normalizeStatus(status: string | null | undefined) {
  return String(status || "unknown").trim().toLowerCase();
}

function isStopped(status: string | null | undefined) {
  const value = normalizeStatus(status);
  return value.includes("stopped") || value === "offline" || value === "shutdown";
}

function isStarted(status: string | null | undefined) {
  const value = normalizeStatus(status);
  return value === "started" || value === "online" || value === "running" || value === "active" || value.includes("started") || value.includes("online") || value.includes("running");
}

async function postAction(
  serverId: string,
  action: "stop" | "start",
) {
  const config = getServerNitradoConfig(serverId);
  const endpoint = action === "stop" ? "stop" : "restart";
  const params = new URLSearchParams(
    action === "stop"
      ? {
          message: "DayZ Bot scheduled restart",
          stop_message: "Server restart initiated by DayZ Bot.",
        }
      : {
          message: "DayZ Bot starting server",
          restart_message: "Server starting after scheduled restart.",
        },
  );

  const url = `https://api.nitrado.net/services/${config.serviceId}/gameservers/${endpoint}?${params.toString()}`;
  console.log(`🎮 NITRADO ACTION REQUEST [${serverId}] action=${action.toUpperCase()} service=${config.serviceId} endpoint=${endpoint} url=${url}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      Accept: "application/json",
    },
  });

  const body = await response.text();
  console.log(`🎮 NITRADO ACTION RESPONSE [${serverId}] action=${action.toUpperCase()} http=${response.status} ok=${response.ok} body=${body.slice(0, 320)}`);
  if (!response.ok) {
    throw new Error(`Nitrado ${action.toUpperCase()} HTTP ${response.status}: ${body.slice(0, 320)}`);
  }

  console.log(`🎮 NITRADO ${action.toUpperCase()} solicitado [${serverId}] service=${config.serviceId}`);
  return body;
}

async function waitForStatus(
  serverId: string,
  predicate: (status: string | null | undefined) => boolean,
  timeoutMs: number,
  label: string,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const response = await getNitradoGameserverStatus(serverId);
    lastStatus = normalizeStatus(response.status);
    console.log(`🎮 NITRADO restart status [${serverId}] ${label}: ${lastStatus}`);

    if (predicate(lastStatus)) return lastStatus;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Nitrado ${label} timeout after ${Math.round(timeoutMs / 1000)}s; lastStatus=${lastStatus}`);
}

/**
 * Nitrado exposes the restart action for starting a server that is stopped.
 * We deliberately use STOP -> wait for stopped -> RESTART/START instead of
 * the single restart endpoint so the Shop gets a deterministic reset window.
 */
export async function stopAndStartNitradoServer(serverId: string) {
  const before = await getNitradoGameserverStatus(serverId);
  const beforeStatus = normalizeStatus(before.status);

  if (isStopped(beforeStatus)) {
    await postAction(serverId, "start");
    const started = await waitForStatus(serverId, isStarted, START_TIMEOUT_MS, "start");
    return { beforeStatus, stoppedAt: undefined, startedStatus: started };
  }

  await postAction(serverId, "stop");
  const stopped = await waitForStatus(serverId, isStopped, STOP_TIMEOUT_MS, "stop");

  await postAction(serverId, "start");
  const started = await waitForStatus(serverId, isStarted, START_TIMEOUT_MS, "start");

  return {
    beforeStatus,
    stoppedAt: stopped,
    startedStatus: started,
  };
}
