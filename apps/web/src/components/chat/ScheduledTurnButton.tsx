import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { CalendarClockIcon, XIcon } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import { cancelScheduledTurn, scheduledTurns } from "../../state/scheduledTurns";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function ScheduledTurnButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  disabledReason: string | null;
  onSchedule: (scheduledAt: string) => Promise<boolean>;
}) {
  const registry = useContext(RegistryContext);
  const query = useMemo(
    () =>
      scheduledTurns({ environmentId: props.environmentId, input: { threadId: props.threadId } }),
    [props.environmentId, props.threadId],
  );
  const result = useAtomValue(query);
  const messages = Option.getOrElse(AsyncResult.value(result), () => []);
  const cancel = useAtomCommand(cancelScheduledTurn, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dateTime, setDateTime] = useState(() =>
    localDateTimeValue(new Date(Date.now() + 60 * 60_000)),
  );

  const schedule = async (date: Date) => {
    if (busy || props.disabledReason) return;
    if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 10_000) {
      toastManager.add({ type: "warning", title: "Choose a future time" });
      return;
    }
    setBusy(true);
    try {
      if (await props.onSchedule(date.toISOString())) {
        registry.refresh(query);
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Schedule message"
            title="Schedule message"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => registry.refresh(query)}
          />
        }
      >
        <CalendarClockIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md" padding="compact">
        <div className="space-y-3 py-1 text-sm">
          <div>
            <div className="font-medium text-foreground">Schedule message</div>
            <p className="mt-1 text-xs text-muted-foreground">
              The server sends it at the chosen time, even if this page is closed.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { label: "In 15 min", minutes: 15 },
              { label: "In 1 hour", minutes: 60 },
              { label: "Tomorrow", minutes: 24 * 60 },
            ].map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || props.disabledReason !== null}
                onClick={() => void schedule(new Date(Date.now() + preset.minutes * 60_000))}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-xs text-muted-foreground">
              Date and time
              <Input
                nativeInput
                type="datetime-local"
                className="mt-1"
                value={dateTime}
                onChange={(event) => setDateTime(event.target.value)}
              />
            </label>
            <Button
              type="button"
              size="sm"
              disabled={busy || props.disabledReason !== null}
              onClick={() => void schedule(new Date(dateTime))}
            >
              Schedule
            </Button>
          </div>
          {props.disabledReason ? (
            <p className="text-xs text-muted-foreground">{props.disabledReason}</p>
          ) : null}
          {messages.length > 0 ? (
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Scheduled for this thread
              </div>
              <div className="max-h-40 space-y-2 overflow-y-auto">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className="flex items-start gap-2 rounded-md bg-muted/50 px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-foreground">{message.text}</div>
                      <div className="text-2xs text-muted-foreground">
                        {message.status === "failed"
                          ? `Failed: ${message.lastError ?? "Could not send"}`
                          : new Date(message.scheduledAt).toLocaleString()}
                      </div>
                    </div>
                    {message.status === "pending" ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Cancel scheduled message"
                        onClick={() => {
                          void cancel({
                            environmentId: props.environmentId,
                            input: { id: message.id, threadId: props.threadId },
                          }).then((outcome) => {
                            if (outcome._tag === "Success") registry.refresh(query);
                          });
                        }}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : result._tag === "Failure" ? (
            <p className="text-xs text-destructive">{formatEnvironmentQueryError(result.cause)}</p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
