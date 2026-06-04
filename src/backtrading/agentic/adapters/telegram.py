"""Wrap universal skill body for Telegram HTML replies."""

from __future__ import annotations

from backtrading.agentic.loader import load_skill


def telegram_channel_skill_instructions() -> str:
    return load_skill("telegram-channel-html")
