"""The plugin's identity and constants that differ between tool packages."""

from __future__ import annotations

#: The plugin's name: used as a log prefix, approval rule key prefix and Hermes toolset prefix.
PLUGIN_NAME = "telegram-tools"

#: The built command-line name used in error and log messages.
CLI_NAME = "telegram-tools-cli"

#: The prefix skills start with: skills named ``<SKILL_PREFIX><topic>`` are registered without it.
SKILL_PREFIX = "telegram-"

#: The emoji each toolset is shown with.
TOOLSET_EMOJI: dict[str, str] = {
    "account": "🪪",
    "chats": "💬",
    "sync": "🔄",
    "files": "📎",
    "sends": "📤",
    "actions": "🔧",
}

#: The settings the tools themselves read: each snake_case name and a type (``text``, ``boolean``, ``number``,
#: ``list``, ``path`` or ``paths``) or a dict with ``type`` and optional bounds (``integer``, ``min``, ``max``),
#: as in ``src/project.ts``. Write OPTIONS on one line with double quotes. A setting ``a_b`` becomes ``--a-b``.
OPTIONS: dict[str, str | dict[str, object]] = {"state_dir": "path", "download_dir": "path", "download_max_mb": {"type": "number", "integer": True, "min": 1, "max": 2000}, "send_dirs": "paths", "keep_disappearing": "boolean", "channels": "boolean"}

__all__ = [
    "CLI_NAME",
    "OPTIONS",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
]
