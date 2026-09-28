import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const scheduledTurns = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:scheduled-turns:list",
  tag: ORCHESTRATION_WS_METHODS.listScheduledTurns,
  staleTimeMs: 2_000,
  idleTtlMs: 60_000,
});

export const scheduleTurn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-turns:schedule",
  tag: ORCHESTRATION_WS_METHODS.scheduleTurn,
});

export const cancelScheduledTurn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-turns:cancel",
  tag: ORCHESTRATION_WS_METHODS.cancelScheduledTurn,
});
