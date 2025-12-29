type BusCallback = (payload?: any) => void;

class EventBus {
  private listeners = new Map<string, Set<BusCallback>>();

  on(event: string, callback: BusCallback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  off(event: string, callback: BusCallback) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  emit(event: string, payload?: any) {
    const set = this.listeners.get(event);
    if (set) {
      set.forEach((cb) => {
        try {
          cb(payload);
        } catch (e) {
          console.error(`[Gilligan] Error in '${event}':`, e);
        }
      });
    }
  }
}

// Singleton for internal wiring
export const internalBus = new EventBus();
