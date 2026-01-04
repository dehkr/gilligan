import type { BusCallback } from './types';

/**
 * Lightweight pub/sub event bus for cross-controller communication.
 */
class EventBus {
  private listeners = new Map<string, Set<BusCallback>>();

  /**
   * Subscribes to a global event and returns an unbind function.
   * 
   * @template T - The expected type of the event detail/payload.
   * @param event - The name of the event to listen for.
   * @param callback - The function to execute. Bound to the controller instance if used in `listen()`.
   * @returns A function that, when called, removes this specific subscription.
   * @example
   * const stop = gn.on('cart:add', (item) => console.log(item));
   * // Later...
   * stop();
   */
  on<T = any>(event: string, callback: BusCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const set = this.listeners.get(event);
    if (set) {
      set.add(callback);
    }

    return () => this.off(event, callback);
  }

  /**
   * Unsubscribes a specific callback from a global event.
   * 
   * @template T - The expected type of the event detail/payload.
   * @param event - The name of the event to stop listening to.
   * @param callback - The specific function reference to remove.
   */
  off<T = any>(event: string, callback: BusCallback<T>) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.delete(callback);
      // Clean up the Map entry if no listeners remain to save memory.
      if (callbacks.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Broadcasts an event to all active subscribers.
   * 
   * @template T - The type of the data being sent.
   * @param event - The name of the event to publish.
   * @param detail - Optional data payload to pass to subscribers.
   * @example
   * gn.emit('cart:updated', { itemCount: 5, total: 49.99 });
   */
  emit<T = any>(event: string, detail?: T) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      // Snapshot of the Set to avoid issues if a listener unsubscribes itself during braodcast.
      const queue = Array.from(callbacks);
      queue.forEach((cb) => {
        try {
          cb(detail);
        } catch (err) {
          console.error(`[Gilligan] Error in global event listener for "${event}":`, err);
        }
      });
    }
  }
}

// Singleton instance used by the framework.
export const internalBus = new EventBus();
