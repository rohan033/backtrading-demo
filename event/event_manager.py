import queue
import threading
from logzero import logger
from typing import TYPE_CHECKING, Dict, Any, Optional
from .db_event_consumer import DbEventWriter

if TYPE_CHECKING:
    from .telegram_listener import TelegramEventListener


class EventManager:
    def __init__(
        self,
        db_logger: DbEventWriter,
        telegram_listener: Optional["TelegramEventListener"] = None,
    ):
        self.db_logger = db_logger
        self.telegram_listener = telegram_listener
        self.log_queue = queue.Queue(maxsize=1000)
        self.worker_thread = None
        self.stop_event = threading.Event()

        self._start_listener()
        sinks = ["db"]
        if telegram_listener is not None:
            sinks.append("telegram")
        logger.info("Event Listener initialized with async queue sinks=%s", "+".join(sinks))

    def _dispatch_event(self, event: dict[str, Any]) -> None:
        order_id = event.get("order_id")
        action = event["action"]
        details = event.get("details") or {}

        self.db_logger.log_event(order_id, action, details)

        if self.telegram_listener is not None:
            try:
                self.telegram_listener.enqueue(order_id, action, details)
            except Exception as exc:
                logger.error("[TELEGRAM] enqueue failed action=%s: %s", action, exc)

    def _event_listener_worker(self):
        while not self.stop_event.is_set():
            try:
                event = self.log_queue.get(timeout=1)
                self._dispatch_event(event)
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Error in event listener worker: {e}")

        logger.info("Event listener worker stopped")
    
    def _start_listener(self):
        self.worker_thread = threading.Thread(
            target=self._event_listener_worker,
            daemon=True,
            name="EventListener-EventWriter"
        )
        self.worker_thread.start()
        logger.info("Event listener worker started")
    
    def log_event(self, order_id: Optional[str], action: str, details: Dict[str, Any]):
        event = {
            'order_id': order_id,
            'action': action,
            'details': details
        }
        
        try:
            self.log_queue.put_nowait(event)
        except queue.Full:
            logger.error(f"Event queue full, dropping: {action}")

    def stop(self):
        logger.info("Stopping Event Listener...")
        self.stop_event.set()
        if self.worker_thread:
            self.worker_thread.join(timeout=5)
        if self.telegram_listener is not None:
            self.telegram_listener.stop()
        logger.info("Event Listener stopped")


def create_event_manager(db_logger: DbEventWriter) -> EventManager:
    """Build EventManager with optional Telegram sink when env is configured."""
    from .telegram_env import load_telegram_env
    from .telegram_listener import maybe_telegram_listener

    load_telegram_env()
    listener = maybe_telegram_listener()
    return EventManager(db_logger, telegram_listener=listener)