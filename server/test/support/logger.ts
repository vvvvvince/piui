import { type Logger, pino } from "pino";

/** A logger that records instead of printing — used to assert on secret hygiene later (M2). */
export interface RecordingLogger {
	logger: Logger;
	lines: string[];
	text(): string;
}

export function silentLogger(): Logger {
	return pino({ level: "silent" });
}

export function recordingLogger(): RecordingLogger {
	const lines: string[] = [];
	const logger = pino(
		{ level: "debug" },
		{
			write(chunk: string) {
				lines.push(chunk.trim());
			},
		},
	);
	return { logger, lines, text: () => lines.join("\n") };
}
