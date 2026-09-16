import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"

export async function run(file, args, options = {}) {
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => {
        stdout += data
    })
    child.stderr.on("data", (data) => {
        stderr += data
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000)
    try {
        const code = await new Promise((resolve, reject) => {
            child.on("error", reject)
            child.on("close", resolve)
        })
        if (options.record) {
            await writeFile(`${options.record}.stdout`, stdout)
            await writeFile(`${options.record}.stderr`, stderr)
        }
        assert.equal(code, 0, `${file} failed: ${stderr.slice(-6000)}\n${stdout.slice(-2000)}`)
        return stdout
    } finally {
        clearTimeout(timeout)
    }
}
