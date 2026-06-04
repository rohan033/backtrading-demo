"""Shim to legacy event package."""

from event.event_manager import EventManager, create_event_manager
from event.db_event_consumer import DbEventWriter

__all__ = ["EventManager", "create_event_manager", "DbEventWriter"]
