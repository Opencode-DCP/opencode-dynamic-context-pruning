import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import assert from "node:assert/strict"
import { isAutoUpdatableSpec, isVersionNewer, updateRemoveDir } from "../lib/update"

test("isVersionNewer compares semver versions", () => {
    assert.equal(isVersionNewer("3.2.0", "3.1.9"), true)
    assert.equal(isVersionNewer("3.1.9", "3.1.9"), false)
    assert.equal(isVersionNewer("3.1.9", "3.2.0"), false)
    assert.equal(isVersionNewer("3.1.9", "3.1.9-beta.1"), true)
})

test("isAutoUpdatableSpec allows latest and ranges", () => {
    assert.equal(isAutoUpdatableSpec("latest"), true)
    assert.equal(isAutoUpdatableSpec("*"), true)
    assert.equal(isAutoUpdatableSpec("^3.1.9"), true)
    assert.equal(isAutoUpdatableSpec(">=3.1.9"), true)
})

test("isAutoUpdatableSpec rejects pinned and non-registry specs", () => {
    assert.equal(isAutoUpdatableSpec("3.1.9"), false)
    assert.equal(isAutoUpdatableSpec("file:../opencode-dcp"), false)
    assert.equal(isAutoUpdatableSpec("github:user/repo"), false)
})

test("updateRemoveDir removes opencode npm wrapper for latest installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@tarquinen", "opencode-dcp@latest")
    const packageDir = join(wrapperDir, "node_modules", "@tarquinen", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@tarquinen/opencode-dcp": "3.1.10" },
    })
    await writePackageJson(packageDir, {
        name: "@tarquinen/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await updateRemoveDir(packageDir, "@tarquinen/opencode-dcp"), wrapperDir)
})

test("updateRemoveDir rejects directories not matching opencode wrapper naming", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    // Simulate .config/opencode-like setup: plugin lives in node_modules but
    // the parent dir is NOT an @scope/pkg@spec wrapper — updateRemoveDir
    // must NOT return the parent dir even if its package.json lists the dep.
    const packageDir = join(rootDir, "node_modules", "@tarquinen", "opencode-dcp")
    await writePackageJson(rootDir, {
        dependencies: { "@tarquinen/opencode-dcp": "latest" },
    })
    await writePackageJson(packageDir, {
        name: "@tarquinen/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await updateRemoveDir(packageDir, "@tarquinen/opencode-dcp"), undefined)
})

test("updateRemoveDir skips version-locked opencode installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@tarquinen", "opencode-dcp@3.1.9")
    const packageDir = join(wrapperDir, "node_modules", "@tarquinen", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@tarquinen/opencode-dcp": "3.1.9" },
    })
    await writePackageJson(packageDir, {
        name: "@tarquinen/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await updateRemoveDir(packageDir, "@tarquinen/opencode-dcp"), undefined)
})

async function writePackageJson(dir: string, data: Record<string, unknown>) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), `${JSON.stringify(data)}\n`, "utf-8")
}
