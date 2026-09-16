// spec/09-api.md §9 — one `/api/events` EventSource per tab, shared by every consumer.
//
// M3's notes flagged the cost of several open streams (HTTP/1.1 gives a tab six connections and
// each conversation already holds one), so the global channel is a module-level singleton with
// a subscriber set instead of one EventSource per component.
import type { GlobalEvent } from "@piui/shared";
import { useEffect } from "react";

type Listener = (event: GlobalEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | undefined;

function ensureSource(): void {
	if (source || typeof EventSource === "undefined") return;
	source = new EventSource("/api/events");
	source.onmessage = (event: MessageEvent<string>) => {
		let parsed: GlobalEvent;
		try {
			parsed = JSON.parse(event.data) as GlobalEvent;
		} catch {
			return; // a malformed frame must never tear the channel down
		}
		for (const listener of [...listeners]) listener(parsed);
	};
	source.onerror = () => {
		// EventSource reconnects on its own; a refused stream (the §5 subscriber cap) simply
		// keeps retrying, and the UI shows its own disconnected state.
	};
}

/** Subscribes for the lifetime of the component. */
export function useGlobalEvents(listener: Listener): void {
	useEffect(() => {
		listeners.add(listener);
		ensureSource();
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				source?.close();
				source = undefined;
			}
		};
	}, [listener]);
}
