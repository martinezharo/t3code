import { ProjectId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration055 from "../persistence/Migrations/055_ScheduledTurns.ts";
import { layer, ScheduledTurns } from "./ScheduledTurns.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const threadId = ThreadId.make("scheduled-test-thread");
const thread = {
  id: threadId,
  projectId: ProjectId.make("scheduled-test-project"),
  archivedAt: null,
} as OrchestrationThreadShell;

it.effect("persists a scheduled turn and dispatches it after the browser is gone", () => {
  const commands: Array<string> = [];
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scheduled = yield* ScheduledTurns;
    yield* Migration055;
    const due = new Date((yield* Clock.currentTimeMillis) + 60_000).toISOString();
    const item = yield* scheduled.schedule({
      threadId,
      text: "  Run this later  ",
      scheduledAt: due,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    assert.equal(item.text, "Run this later");
    assert.equal((yield* scheduled.list(threadId)).length, 1);
    yield* sql`UPDATE scheduled_turns SET next_attempt_at = '0001-01-01T00:00:00.000Z' WHERE id = ${item.id}`;
    yield* scheduled.drainDue;
    assert.deepEqual(commands, ["Run this later"]);
    assert.equal((yield* scheduled.list(threadId)).length, 0);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadShellById: () => Effect.succeed(Option.some(thread)),
            }),
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) => {
                if (command.type === "thread.turn.start") commands.push(command.message.text);
                return Effect.succeed({ sequence: 1 });
              },
            }),
          ),
        ),
      ),
    ),
  );
});
