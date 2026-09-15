# S4 — `AgentSessionEvent` union (what `event-map.ts` must project)

- **Question:** which events fire, in what order, with which fields?
- **Spec assumption:** `02-data-model.md` §§4–5.
- **Verified against:** `dist/core/agent-session.d.ts`; observed live in
  `s2-s5-resources-events.mjs`.
- **Answer:** **differs from the spec's mental model in one important way.**

Observed order for "thinking + tool call, then final text" (two scripted turns):

```
agent_start()
turn_start()
message_start(message)            // user message
message_end(message)
message_start(message)            // assistant
message_update(assistantMessageEvent, message)   // xN — the DELTAS live here
message_end(message)
tool_execution_start(toolCallId, toolName, args)
tool_execution_end(toolCallId, toolName, result, isError)
message_start(message) / message_end(message)    // toolResult message
turn_end(message, toolResults)
turn_start() … message_update … message_end … turn_end
agent_end(messages, willRetry)
agent_settled()
```

Key facts:

- **There are no top-level `text_delta` events.** Deltas arrive wrapped:
  `{ type: "message_update", assistantMessageEvent: <pi-ai AssistantMessageEvent>, message }`,
  where `assistantMessageEvent.type` is one of
  `start | text_start | text_delta | text_end | thinking_start | thinking_delta | thinking_end |
  toolcall_start | toolcall_delta | toolcall_end | done | error`, each carrying `contentIndex`
  and `partial`. `event-map.ts` therefore unwraps `assistantMessageEvent` and keys blocks by
  `contentIndex`.
- Tool calls surface twice: inside the assistant message content (`toolcall_*`) and as
  `tool_execution_start/end`. The `tool` UiBlock merges them by `toolCallId`
  (`tool_execution_end.result = { content: [{type:"text",text}] }`, plus `isError: boolean`).
- Session-level extras that the projector must handle:
  `queue_update{steering,followUp}`, `compaction_start/compaction_end`,
  `auto_retry_start/auto_retry_end`, `summarization_retry_*`, `entry_appended{entry}`,
  `session_info_changed{name}`, `thinking_level_changed{level}`, `bash_execution_update`.
- `agent_end` carries `willRetry: boolean` — `done` must **not** be emitted when `willRetry`
  is true.

- **Consequence:** `02-data-model.md` §5 stays valid as the *output* union; the *input* is the
  list above. The recorded fixture for `event-map.ts` (`20-development-method.md` §6) is a
  capture of these events, produced by the fake provider rather than a real model.
- **Date:** 2026-09-15
