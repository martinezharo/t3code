import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  OrchestrationScheduledTurnError,
  ThreadId,
  type ScheduleTurnInput,
  type ScheduledTurn,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";

interface ScheduledTurnRow {
  readonly id: string;
  readonly thread_id: string;
  readonly command_json: string;
  readonly scheduled_at: string;
  readonly status: ScheduledTurn["status"] | "dispatching";
  readonly attempts: number;
  readonly last_error: string | null;
  readonly created_at: string;
}

const toPublic = (row: ScheduledTurnRow): ScheduledTurn => {
  const command = JSON.parse(row.command_json) as typeof ThreadTurnStartCommand.Type;
  return {
    id: row.id,
    threadId: ThreadId.make(row.thread_id),
    text: command.message.text,
    scheduledAt: row.scheduled_at,
    status: row.status === "dispatching" ? "pending" : row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
};

const failure = (message: string) => new OrchestrationScheduledTurnError({ message });
const MAX_DISPATCH_ATTEMPTS = 288;

export class ScheduledTurns extends Context.Service<
  ScheduledTurns,
  {
    readonly schedule: (
      input: ScheduleTurnInput,
    ) => Effect.Effect<ScheduledTurn, OrchestrationScheduledTurnError>;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ScheduledTurn>, OrchestrationScheduledTurnError>;
    readonly cancel: (input: {
      id: string;
      threadId: ThreadId;
    }) => Effect.Effect<{ cancelled: boolean }, OrchestrationScheduledTurnError>;
    readonly drainDue: Effect.Effect<void, unknown>;
  }
>()("t3/orchestration/ScheduledTurns") {}

export const layer = Layer.effect(
  ScheduledTurns,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;

    const schedule = (input: ScheduleTurnInput) =>
      Effect.gen(function* () {
        const text = input.text.trim();
        if (!text) return yield* failure("Write a message before scheduling it.");
        const now = yield* Clock.currentTimeMillis;
        const due = Date.parse(input.scheduledAt);
        if (!Number.isFinite(due) || due < now + 10_000 || due > now + 30 * 24 * 60 * 60_000) {
          return yield* failure("Choose a time from 10 seconds to 30 days from now.");
        }
        const thread = yield* snapshots.getThreadShellById(input.threadId);
        if (Option.isNone(thread) || thread.value.archivedAt !== null) {
          return yield* failure("This thread is no longer available.");
        }
        const id = NodeCrypto.randomUUID();
        const command: typeof ThreadTurnStartCommand.Type = {
          type: "thread.turn.start",
          commandId: CommandId.make(`scheduled:${id}`),
          threadId: input.threadId,
          message: {
            messageId: MessageId.make(id),
            role: "user",
            text,
            attachments: [],
          },
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt: new Date(due).toISOString(),
        };
        const createdAt = new Date(now).toISOString();
        const scheduledAt = new Date(due).toISOString();
        yield* sql`
          INSERT INTO scheduled_turns
          (id, thread_id, command_json, scheduled_at, next_attempt_at, created_at, updated_at)
          VALUES (${id}, ${input.threadId}, ${JSON.stringify(command)}, ${scheduledAt}, ${scheduledAt}, ${createdAt}, ${createdAt})
        `;
        return {
          id,
          threadId: input.threadId,
          text,
          scheduledAt,
          status: "pending" as const,
          lastError: null,
          createdAt,
        };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof OrchestrationScheduledTurnError
            ? error
            : failure("Could not schedule the message."),
        ),
      );

    const list = (threadId: ThreadId) =>
      sql<ScheduledTurnRow>`
        SELECT id, thread_id, command_json, scheduled_at, status, attempts, last_error, created_at
        FROM scheduled_turns
        WHERE thread_id = ${threadId} AND status IN ('pending', 'dispatching', 'failed')
        ORDER BY scheduled_at ASC
        LIMIT 100
      `.pipe(
        Effect.map((rows) => rows.map(toPublic)),
        Effect.mapError(() => failure("Could not load scheduled messages.")),
      );

    const cancel = (input: { id: string; threadId: ThreadId }) =>
      Effect.gen(function* () {
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        const rows = yield* sql<{ id: string }>`
          UPDATE scheduled_turns
          SET status = 'cancelled', updated_at = ${now}
          WHERE id = ${input.id} AND thread_id = ${input.threadId} AND status = 'pending'
          RETURNING id
        `;
        return { cancelled: rows.length > 0 };
      }).pipe(Effect.mapError(() => failure("Could not cancel the scheduled message.")));

    const drainDue = Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const staleBefore = new Date(Date.parse(now) - 60_000).toISOString();
      // A server crash or interrupted dispatch must not strand a claimed turn.
      // Reusing its command ID lets the engine reject an already recorded command.
      yield* sql`
        UPDATE scheduled_turns SET status = 'pending', updated_at = ${now}
        WHERE status = 'dispatching' AND updated_at <= ${staleBefore}
      `;
      const dueRows = yield* sql<ScheduledTurnRow>`
        SELECT id, thread_id, command_json, scheduled_at, status, attempts, last_error, created_at
        FROM scheduled_turns
        WHERE status = 'pending' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at ASC
        LIMIT 20
      `;
      for (const row of dueRows) {
        const claimed = yield* sql<{ id: string }>`
          UPDATE scheduled_turns SET status = 'dispatching', updated_at = ${now}
          WHERE id = ${row.id} AND status = 'pending'
          RETURNING id
        `;
        if (claimed.length === 0) continue;
        const command = JSON.parse(row.command_json) as typeof ThreadTurnStartCommand.Type;
        const result = yield* engine.dispatch(command).pipe(Effect.result);
        const updatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        if (Result.isSuccess(result)) {
          yield* sql`
            UPDATE scheduled_turns SET status = 'sent', last_error = NULL, updated_at = ${updatedAt}
            WHERE id = ${row.id}
          `;
        } else {
          const attempts = row.attempts + 1;
          const retryDelayMs = Math.min(30_000 * 2 ** Math.min(attempts - 1, 4), 5 * 60_000);
          const retryAt = new Date(Date.parse(updatedAt) + retryDelayMs).toISOString();
          const detail = "Could not start the turn.";
          yield* sql`
            UPDATE scheduled_turns
            SET status = ${attempts >= MAX_DISPATCH_ATTEMPTS ? "failed" : "pending"}, attempts = ${attempts},
                next_attempt_at = ${retryAt}, last_error = ${detail}, updated_at = ${updatedAt}
            WHERE id = ${row.id}
          `;
        }
      }
    });

    return ScheduledTurns.of({ schedule, list, cancel, drainDue });
  }),
);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduled = yield* ScheduledTurns;
    const sql = yield* SqlClient.SqlClient;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    yield* Effect.gen(function* () {
      yield* startup.awaitCommandReady;
      yield* sql`UPDATE scheduled_turns SET status = 'pending' WHERE status = 'dispatching'`.pipe(
        Effect.orDie,
      );
      yield* scheduled.drainDue.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Scheduled turn drain failed", { cause })),
        Effect.repeat(Schedule.spaced("2 seconds")),
      );
    }).pipe(Effect.forkScoped);
  }),
);
