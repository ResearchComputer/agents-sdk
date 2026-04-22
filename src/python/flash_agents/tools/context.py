"""ToolContext — what a tool's execute() receives as its second arg."""

from __future__ import annotations

import logging
from dataclasses import dataclass


@dataclass(frozen=True)
class ToolContext:
    """Handed to a tool at call time.

    Fields:
        cwd: the agent's configured working directory.
        call_id: unique id for this invocation (matches
            tool_execution_start event).
        logger: namespaced logger under 'flash_agents.tools'.
    """
    cwd: str
    call_id: str
    logger: logging.Logger
