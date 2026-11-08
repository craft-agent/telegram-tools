"""Tests of the settings the plugin turns into command-line flags."""

from __future__ import annotations

import unittest
from typing import Any

from support import StubContext, settings


class SettingsFlagsTest(unittest.TestCase):
    def flags(self, **config: Any) -> list[str]:
        return settings.settings_flags(StubContext(config))

    def test_no_setting_gives_no_flag(self) -> None:
        self.assertEqual(self.flags(), [])

    def test_each_setting_becomes_its_flag(self) -> None:
        self.assertEqual(
            self.flags(
                toolsets=["things", "widgets"],
                read_only=True,
                keep_disappearing=True,
                channels=True,
                tools=["demo_thing_read"],
                exclude_tools=["demo_widget_update", "demo_gadget_edit"],
            ),
            [
                "--toolsets",
                "things,widgets",
                "--read-only",
                "--keep-disappearing",
                "--channels",
                "--tools",
                "demo_thing_read",
                "--exclude-tools",
                "demo_widget_update,demo_gadget_edit",
            ],
        )

    def test_all_toolsets_as_text_or_as_a_list(self) -> None:
        self.assertEqual(self.flags(toolsets="all"), ["--toolsets", "all"])
        self.assertEqual(self.flags(toolsets=["all"]), ["--toolsets", "all"])

    def test_false_and_empty_settings_give_no_flag(self) -> None:
        self.assertEqual(
            self.flags(
                toolsets=[],
                read_only=False,
                keep_disappearing=False,
                channels=False,
                tools=[],
                exclude_tools=[],
            ),
            [],
        )

    def test_state_dir_flag(self) -> None:
        self.assertEqual(
            settings.state_dir_flags(StubContext({"state_dir": "/custom/path"})), ["--state-dir", "/custom/path"]
        )
        self.assertEqual(settings.state_dir_flags(StubContext({})), [])

    def test_state_dir_included_in_settings_flags(self) -> None:
        self.assertEqual(self.flags(state_dir="/custom/path"), ["--state-dir", "/custom/path"])

    def test_invalid_state_dir_refused(self) -> None:
        for value in (123, True, "", "   ", []):
            with self.subTest(value=value), self.assertRaises(settings.SettingsError):
                settings.state_dir_flags(StubContext({"state_dir": value}))

    def test_a_wrong_type_is_refused(self) -> None:
        for config in (
            {"toolsets": "things"},
            {"toolsets": 3},
            {"read_only": "true"},
            {"keep_disappearing": "true"},
            {"keep_disappearing": 1},
            {"channels": "true"},
            {"channels": 0},
            {"tools": "demo_thing_read"},
            {"exclude_tools": [1]},
            {"state_dir": 123},
            {"state_dir": ""},
        ):
            with self.subTest(config=config), self.assertRaises(settings.SettingsError):
                self.flags(**config)

    def test_download_settings_become_flags(self) -> None:
        self.assertEqual(
            self.flags(download_dir="~/Downloads/example", download_max_mb=100),
            ["--download-dir", "~/Downloads/example", "--download-max-mb", "100"],
        )
        for value in (1, 2000):
            self.assertEqual(self.flags(download_max_mb=value), ["--download-max-mb", str(value)])

    def test_invalid_download_settings_refused(self) -> None:
        for value in (123, True, "", "   ", []):
            with self.subTest(value=value), self.assertRaisesRegex(settings.SettingsError, "download_dir"):
                self.flags(download_dir=value)
        for value in (0, 2001, 1.5, 1.0, "100", "text", True, False, []):
            with self.subTest(value=value), self.assertRaisesRegex(settings.SettingsError, "download_max_mb"):
                self.flags(download_max_mb=value)


if __name__ == "__main__":
    unittest.main()
