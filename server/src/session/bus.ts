// The global notification channel behind GET /api/events (spec/09-api.md §9).
import type { GlobalEvent } from "@piui/shared";

export type GlobalEventListener = (event: GlobalEvent) => void;

export class GlobalEventBus {
	private readonly listeners = new Set<GlobalEventListener>();

	subscribe(listener: GlobalEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(event: GlobalEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	get subscriberCount(): number {
		return this.listeners.size;
	}
}
