// Deployment artifacts are declarative, so they are tested behaviorally
// (spec/20-development-method.md §7): what the files promise must actually hold.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const read = (name: string) => readFileSync(join(repoRoot, name), "utf8");

const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yaml");
const envExample = read(".env.example");

function hasDocker(): boolean {
	try {
		execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function composeConfig(env: Record<string, string>): { ok: boolean; output: string } {
	try {
		const output = execFileSync("docker", ["compose", "--env-file", "/dev/null", "config"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, output };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string };
		return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

describe("deployment artifacts", () => {
	it("[19-deployment#9.1] compose resolves with nothing but .env.example values", () => {
		const env = Object.fromEntries(
			envExample
				.split("\n")
				.filter((l) => l.trim() && !l.startsWith("#"))
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
		expect(env.PIUI_SESSION_SECRET).toBeTruthy();
		expect(existsSync(join(repoRoot, "docker-compose.override.yaml.example"))).toBe(true);
		if (!hasDocker()) return;
		const result = composeConfig(env);
		expect(result.ok, result.output).toBe(true);
		expect(result.output).toMatch(/host_ip:\s*127\.0\.0\.1/);
		expect(result.output).toMatch(/published:\s*"?8787"?/);
		expect(result.output).toContain("/data");
	});

	it("[19-deployment#9.2] compose fails with a clear message when PIUI_SESSION_SECRET is unset", () => {
		expect(compose).toMatch(/PIUI_SESSION_SECRET:\s*\$\{PIUI_SESSION_SECRET:\?/);
		if (!hasDocker()) return;
		const result = composeConfig({});
		expect(result.ok).toBe(false);
		expect(result.output).toContain("PIUI_SESSION_SECRET");
		expect(result.output.toLowerCase()).toContain(".env");
	});

	it("[19-deployment#9.9] runs as uid 10001, ships no build toolchain and never mounts the docker socket", () => {
		const runtimeStage = dockerfile.slice(dockerfile.indexOf("AS runtime"));
		expect(runtimeStage).toMatch(/useradd --uid 10001/);
		expect(runtimeStage).toMatch(/^USER piui$/m);
		for (const toolchain of ["g++", "make", "build-essential", "python3"]) {
			expect(runtimeStage.includes(toolchain), `runtime stage must not install ${toolchain}`).toBe(
				false,
			);
		}
		expect(runtimeStage).toMatch(/tini/);
		expect(runtimeStage).toMatch(/HEALTHCHECK[\s\S]*api\/health/);

		for (const file of [
			"docker-compose.yaml",
			"Dockerfile",
			"docker-compose.override.yaml.example",
		]) {
			// Comments may *mention* these (the compose file explains why they are absent).
			const text = read(file)
				.split("\n")
				.filter((line) => !line.trim().startsWith("#"))
				.join("\n");
			expect(text.includes("docker.sock"), `${file} must not reference the docker socket`).toBe(
				false,
			);
			expect(text.includes("network_mode: host"), `${file} must not use host networking`).toBe(
				false,
			);
			expect(text.includes("privileged: true"), `${file} must not be privileged`).toBe(false);
		}
	});

	it("keeps the image lean: .dockerignore excludes node_modules, dist output and the spec", () => {
		const ignore = read(".dockerignore");
		for (const entry of ["node_modules", "client/dist", "server/dist", "spec", ".git"]) {
			expect(ignore).toContain(entry);
		}
	});
});
