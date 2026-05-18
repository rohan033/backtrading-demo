import queue
import threading
from logzero import logger
from typing import Dict, Any, Optional
from .db_event_consumer import DbEventWriter

class EventManager:
    def __init__(self, db_logger: DbEventWriter):
        self.db_logger = db_logger
        self.log_queue = queue.Queue(maxsize=1000)
        self.worker_thread = None
        self.stop_event = threading.Event()
    
        self._start_listener()    
        logger.info("Event Listener initialized with async queue")
    
    def _event_listener_worker(self):
        while not self.stop_event.is_set():
            try:
                event = self.log_queue.get(timeout=1)
                self.db_logger.log_event(
                    event['order_id'],
                    event['action'],
                    event['details']
                )
                
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
        logger.info("Event Listener stopped")