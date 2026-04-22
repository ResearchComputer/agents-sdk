"""AgentEvent TypedDicts mirroring pi-agent-core's AgentEvent union.

Field names are camelCase because the events arrive as JSON from the
guest and we don't re-case at the boundary.

Canonical reference:
  node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:248
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union


class _AgentStart(TypedDict):
    type: Literal["agent_start"]


class _AgentEnd(TypedDict):
    type: Literal["agent_end"]
    messages: list[dict]


class _TurnStart(TypedDict):
    type: Literal["turn_start"]


class _TurnEnd(TypedDict):
    type: Literal["turn_end"]
    message: dict
    toolResults: list[dict]


class _MessageStart(TypedDict):
    type: Literal["message_start"]
    message: dict


class _MessageUpdate(TypedDict):
    type: Literal["message_update"]
    message: dict
    assistantMessageEvent: dict


class _MessageEnd(TypedDict):
    type: Literal["message_end"]
    message: dict


class _ToolExecutionStart(TypedDict):
    type: Literal["tool_execution_start"]
    toolCallId: str
    toolName: str
    args: Any


class _ToolExecutionUpdate(TypedDict):
    type: Literal["tool_execution_update"]
    toolCallId: str
    toolName: str
    args: Any
    partialResult: Any


class _ToolExecutionEnd(TypedDict):
    type: Literal["tool_execution_end"]
    toolCallId: str
    toolName: str
    result: Any
    isError: bool


AgentEvent = Union[
    _AgentStart,
    _AgentEnd,
    _TurnStart,
    _TurnEnd,
    _MessageStart,
    _MessageUpdate,
    _MessageEnd,
    _ToolExecutionStart,
    _ToolExecutionUpdate,
    _ToolExecutionEnd,
]
