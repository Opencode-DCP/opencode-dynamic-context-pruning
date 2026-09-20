import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))

function dataPath(env) {
    return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local/share"), "opencode")
}

export function authPath(major, env = process.env) {
    if (env.DCP_AUTH_PATH) return resolve(env.DCP_AUTH_PATH)
    if (major === 1) return join(dataPath(env), "auth.json")
    try {
        return execFileSync("opencode2", ["debug", "paths", "db"], {
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim()
    } catch (error) {
        if (error.code !== "ENOENT") throw error
    }
    const database = env.OPENCODE_DB || "opencode.db"
    return isAbsolute(database) ? database : join(dataPath(env), database)
}

export function copyAuth(major, destination, image) {
    const source = authPath(major)
    if (!existsSync(source))
        throw new Error(
            `OpenCode V${major} authentication not found at ${source}. Sign in with OpenCode or set DCP_AUTH_PATH.`,
        )
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    if (major === 1) {
        writeFileSync(destination, readFileSync(source), { mode: 0o600 })
        return
    }
    // Only this short-lived exporter sees the host database, mounted read-only.
    // The sandbox receives credential records, never the host session database.
    execFileSync(
        "docker",
        [
            "run",
            "--rm",
            "--user",
            `${process.getuid()}:${process.getgid()}`,
            "--mount",
            `type=bind,source=${dirname(source)},target=/source,readonly`,
            "--mount",
            `type=bind,source=${dirname(destination)},target=/export`,
            "--mount",
            `type=bind,source=${directory},target=/launcher,readonly`,
            image,
            "node",
            "--disable-warning=ExperimentalWarning",
            "/launcher/auth.mjs",
            join("/source", basename(source)),
            join("/export", basename(destination)),
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
    )
}

export async function exportAuth(source, destination) {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(source, { readOnly: true })
    try {
        // A read transaction keeps credentials and provider discovery consistent,
        // including committed WAL entries, without copying conversation data.
        db.exec("BEGIN")
        const credentials = db.prepare("SELECT * FROM credential").all()
        const sources = db.prepare("SELECT value FROM kv WHERE key = ?").get("wellknown:sources")
        db.exec("COMMIT")
        writeFileSync(destination, JSON.stringify({ credentials, sources }), { mode: 0o600 })
    } finally {
        db.close()
    }
}

export async function restoreAuth(major, source, cli, env = process.env) {
    const data = dataPath(env)
    mkdirSync(data, { recursive: true, mode: 0o700 })
    if (major === 1) {
        writeFileSync(join(data, "auth.json"), readFileSync(source), { mode: 0o600 })
        return
    }
    // Let this OpenCode release initialize/migrate its own isolated database,
    // then import authentication while its private server is stopped.
    execFileSync(cli, ["auth", "list", "--standalone", "--format", "json"], {
        env,
        cwd: env.PWD,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
    })
    const database = execFileSync(cli, ["debug", "paths", "db"], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    const auth = JSON.parse(readFileSync(source, "utf8"))
    await importAuth(database, auth)
}

export async function importAuth(database, auth) {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(database)
    try {
        db.exec("BEGIN IMMEDIATE")
        db.exec("DELETE FROM credential")
        for (const credential of auth.credentials) {
            const columns = Object.keys(credential)
            db.prepare(
                `INSERT INTO credential (${columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            ).run(...Object.values(credential))
        }
        db.prepare("DELETE FROM kv WHERE key = ?").run("wellknown:sources")
        if (auth.sources) {
            const now = Date.now()
            db.prepare(
                "INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)",
            ).run("wellknown:sources", auth.sources.value, now, now)
        }
        db.exec("COMMIT")
    } finally {
        // Closing on failure rolls back rather than leaving partial credentials.
        db.close()
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.umask(0o077)
    await exportAuth(process.argv[2], process.argv[3])
}
