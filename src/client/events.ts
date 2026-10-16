export type Handler<T> = (value: T) => void;

/** Minimal typed pub/sub - one instance per event channel. */
export class Emitter<T> {
  private handlers = new Set<Handler<T>>();

  on(handler: Handler<T>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(value: T): void {
    for (const handler of this.handlers) handler(value);
  }

  clear(): void {
    this.handlers.clear();
  }
}
