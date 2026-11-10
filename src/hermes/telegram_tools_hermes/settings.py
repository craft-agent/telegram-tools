"""The plugin's settings, turned into the flags of the command line."""

from __future__ import annotations

from typing import Any

from .context import PluginContext

#: The value of ``toolsets`` that turns on every toolset.
ALL_TOOLSETS = "all"
MAX_DOWNLOAD_MB = 2000


class SettingsError(ValueError):
    """A setting has a value of the wrong type."""


def _names(key: str, value: Any) -> str | None:
    """A list of names as the comma-separated text a flag takes; ``None`` for no names."""
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise SettingsError(f'setting "{key}" must be a list of names')
    return ",".join(value) or None


def state_dir_flags(ctx: PluginContext) -> list[str]:
    """Read ``state_dir`` and return ``["--state-dir", value]``, or ``[]`` when absent.

    Raises:
        SettingsError: the setting is present but not a non-empty string.
    """
    state_dir = ctx.get_config("state_dir")
    if state_dir is None:
        return []
    if not isinstance(state_dir, str) or not state_dir.strip():
        raise SettingsError('setting "state_dir" must be a path')
    return ["--state-dir", state_dir]


def _is_path_item(item: Any) -> bool:
    """Whether ``item`` is a non-empty string that survives the flag's comma-separated form whole."""
    return isinstance(item, str) and bool(item.strip()) and "," not in item


def send_dirs_flags(ctx: PluginContext) -> list[str]:
    """Read ``send_dirs`` and return ``["--send-dirs", "a,b"]``, or ``[]`` when absent or empty.

    The flag is comma-separated, so a path holding a comma is refused rather than split in two.

    Raises:
        SettingsError: the setting is present but not a list of non-empty strings without commas.
    """
    value = ctx.get_config("send_dirs")
    if value is None:
        return []
    if not isinstance(value, list) or not all(_is_path_item(item) for item in value):
        raise SettingsError('setting "send_dirs" must be a list of paths without commas')
    return ["--send-dirs", ",".join(value)] if value else []


def language_setting(ctx: PluginContext) -> str | None:
    """The ``language`` setting, stripped; ``None`` when it is absent, blank or not a string.

    It is no flag of ``settings_flags``: only ``target`` takes a language.
    """
    value = ctx.get_config("language")
    return (value.strip() or None) if isinstance(value, str) else None


def settings_flags(ctx: PluginContext) -> list[str]:
    """Read the plugin's settings and return the flags that say the same.

    A setting that is absent gives no flag, so the command line's own defaults
    (and ``TELEGRAM_TOOLS_*`` variables) apply. A wrong type is refused rather
    than ignored, since ignoring ``read_only`` would loosen what the person asked for.

    Raises:
        SettingsError: a setting has a value of the wrong type.
    """
    flags: list[str] = []

    toolsets = ctx.get_config("toolsets")
    if toolsets == ALL_TOOLSETS:
        flags += ["--toolsets", ALL_TOOLSETS]
    elif toolsets is not None and (names := _names("toolsets", toolsets)):
        flags += ["--toolsets", names]

    for key, flag in (
        ("read_only", "--read-only"),
        ("keep_disappearing", "--keep-disappearing"),
        ("channels", "--channels"),
    ):
        value = ctx.get_config(key)
        if value is not None and not isinstance(value, bool):
            raise SettingsError(f'setting "{key}" must be true or false')
        if value:
            flags.append(flag)

    for key, flag in (("tools", "--tools"), ("exclude_tools", "--exclude-tools")):
        value = ctx.get_config(key)
        if value is not None and (names := _names(key, value)):
            flags += [flag, names]

    flags += state_dir_flags(ctx)

    download_dir = ctx.get_config("download_dir")
    if download_dir is not None:
        if not isinstance(download_dir, str) or not download_dir.strip():
            raise SettingsError('setting "download_dir" must be a path')
        flags += ["--download-dir", download_dir]

    download_max_mb = ctx.get_config("download_max_mb")
    if download_max_mb is not None:
        if type(download_max_mb) is not int or not 1 <= download_max_mb <= MAX_DOWNLOAD_MB:
            raise SettingsError(f'setting "download_max_mb" must be an integer from 1 to {MAX_DOWNLOAD_MB}')
        flags += ["--download-max-mb", str(download_max_mb)]

    flags += send_dirs_flags(ctx)

    return flags
