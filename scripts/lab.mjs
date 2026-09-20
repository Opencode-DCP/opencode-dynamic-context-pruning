import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyAuth } from "./sandbox/auth.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root =
    process.env.DCP_LAB_DIR ||
    `/tmp/opencode/dcp-lab/${new Date().toISOString().replace(/[:.]/g, "-")}`
const artifacts = join(root, "artifacts")
const runtime = join(root, "runtime")
const live = process.argv.includes("--live")
mkdirSync(artifacts, { recursive: true, mode: 0o700 })
mkdirSync(runtime, { recursive: true, mode: 0o700 })
execFileSync("npm", ["pack", "--pack-destination", artifacts], {
    cwd: join(repo, "tests/logger"),
    stdio: "pipe",
})
if (!live && !process.argv.includes("--built")) {
    execFileSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit" })
}
execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", artifacts], {
    cwd: repo,
    stdio: "pipe",
})
console.log(`Lab output: ${root}`)
const auth = join(artifacts, "auth.json")
try {
    if (live) copyAuth(2, auth, "dcp-lab:2.0.4")
    execFileSync(
        "docker",
        [
            "run",
            "--rm",
            "--init",
            "--user",
            `${process.getuid()}:${process.getgid()}`,
            "--mount",
            `type=bind,source=${runtime},target=/lab`,
            "--mount",
            `type=bind,source=${artifacts},target=/artifacts,readonly`,
            "--mount",
            `type=bind,source=${join(repo, "tests/lab")},target=/test,readonly`,
            "--mount",
            `type=bind,source=${join(repo, "scripts/sandbox")},target=/sandbox,readonly`,
            "dcp-lab:2.0.4",
            "node",
            live ? "/test/live.mjs" : "/test/run.mjs",
        ],
        { stdio: "inherit" },
    )
} finally {
    rmSync(auth, { force: true })
}
