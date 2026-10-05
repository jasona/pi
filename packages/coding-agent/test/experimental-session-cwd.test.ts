import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveSessionCwd } from "../src/experimental/server.ts";

describe("resolveSessionCwd", () => {
	let root: string;

	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "pi-session-cwd-")));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("defaults to the server's own directory when none is requested", async () => {
		await expect(resolveSessionCwd(undefined)).resolves.toBe(process.cwd());
	});

	test("accepts an existing absolute directory", async () => {
		await expect(resolveSessionCwd(root)).resolves.toBe(root);
	});

	test("resolves a symlink to the real directory", async () => {
		const real = join(root, "real");
		await mkdir(real);
		const link = join(root, "link");
		await symlink(real, link);
		await expect(resolveSessionCwd(link)).resolves.toBe(real);
	});

	test.each([
		["a relative path", "relative/dir"],
		["an empty string", ""],
	])("refuses %s", async (_label, value) => {
		await expect(resolveSessionCwd(value)).rejects.toMatchObject({
			code: "service_invalid_value",
			message: expect.stringContaining("absolute"),
		});
	});

	test("refuses a path that does not exist", async () => {
		await expect(resolveSessionCwd(join(root, "missing"))).rejects.toMatchObject({
			code: "service_invalid_value",
			message: expect.stringContaining("not an existing directory"),
		});
	});

	test("refuses a file", async () => {
		const file = join(root, "file.txt");
		await writeFile(file, "x");
		await expect(resolveSessionCwd(file)).rejects.toMatchObject({ code: "service_invalid_value" });
	});
});
