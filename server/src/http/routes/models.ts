// spec/09-api.md §3 — GET /api/models.
import type { ModelsResponse } from "@piui/shared";
import type { Services } from "../../services.js";
import type { PiuiFastify } from "../auth.js";

export async function registerModelRoutes(app: PiuiFastify, services: Services): Promise<void> {
	app.get<{ Querystring: { refresh?: string } }>(
		"/api/models",
		async (req): Promise<ModelsResponse> => {
			if (req.query.refresh === "1") return services.models.refresh();
			return services.models.list();
		},
	);
}
