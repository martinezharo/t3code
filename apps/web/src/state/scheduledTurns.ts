import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type ScheduledTurn,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback, useContext, useEffect, useMemo } from "react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

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

const EMPTY_SCHEDULED_TURNS: ReadonlyArray<ScheduledTurn> = [];

/**
 * A thread's unsent scheduled messages, refreshed when the earliest one comes
 * due so it leaves the chat once the server has sent it. While it is overdue
 * the server is retrying, so the list is re-read slowly until it settles.
 */
export function useThreadScheduledTurns(environmentId: EnvironmentId, threadId: ThreadId | null) {
  const registry = useContext(RegistryContext);
  const query = useMemo(
    // With no thread the query is never read: the hook returns an empty list.
    () => scheduledTurns({ environmentId, input: { threadId: threadId ?? ("" as ThreadId) } }),
    [environmentId, threadId],
  );
  const result = useAtomValue(query);
  const turns = Option.getOrElse(AsyncResult.value(result), () => EMPTY_SCHEDULED_TURNS);
  const cancelCommand = useAtomCommand(cancelScheduledTurn, { reportFailure: false });

  const nextDueAt = useMemo(() => {
    let earliest = Number.POSITIVE_INFINITY;
    for (const turn of turns) {
      if (turn.status === "pending") earliest = Math.min(earliest, Date.parse(turn.scheduledAt));
    }
    return earliest;
  }, [turns]);
  useEffect(() => {
    if (threadId === null || !Number.isFinite(nextDueAt)) return;
    const overdue = nextDueAt <= Date.now();
    const timer = setTimeout(
      () => registry.refresh(query),
      overdue ? 10_000 : nextDueAt - Date.now() + 3_000,
    );
    return () => clearTimeout(timer);
  }, [nextDueAt, query, registry, result, threadId]);

  /** Cancels a pending message and returns its text, or null when it already went out. */
  const cancel = useCallback(
    async (id: string) => {
      if (threadId === null) return null;
      const text = turns.find((turn) => turn.id === id)?.text ?? null;
      const outcome = await cancelCommand({ environmentId, input: { id, threadId } });
      registry.refresh(query);
      return outcome._tag === "Success" && outcome.value.cancelled ? text : null;
    },
    [cancelCommand, environmentId, query, registry, threadId, turns],
  );

  return { turns: threadId === null ? EMPTY_SCHEDULED_TURNS : turns, cancel };
}
