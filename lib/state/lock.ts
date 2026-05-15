/**
 * Cross-process session lock primitives for DCP.
 *
 * Serializes mutations to the persisted session state file at
 * `${XDG_DATA_HOME || ~/.local/share}/opencode/storage/plugin/dcp/{sessionId}.json`
 * by maintaining a sibling `{sessionId}.json.lock` file containing `{ pid, timestamp }`.
 *
 * Acquisition uses POSIX-atomic `open(path, "wx")`. On EEXIST, the holder's PID and
 * timestamp are inspected to decide between waiting, taking over a dead process's
 * lock, or taking over an alive-but-stale (>30s old) lock.
 *
 * Takeover precedence (strict order, evaluated on every retry):
 *   1. Holder PID is dead (`process.kill(pid, 0)` throws ESRCH) -> immediate takeover.
 *   2. Holder PID alive but `Date.now() - timestamp > 30_000` -> warn + takeover.
 *   3. Otherwise -> `sleep(50ms)` + retry, up to 100 attempts (~5s total).
 *
 * After 100 attempts a `LockTimeoutError` is thrown.
 *
 * Per Phase 0 Contract C, only the state-mutation portion of compress should be wrapped
 * by `withSessionLock`. Long-running operations (e.g. the model API call) MUST happen
 * outside the critical section so the lock is never held across network IO.
 */

import { mkdir, open, readFile, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

const STALE_LOCK_MS = 30_000
const RETRY_DELAY_MS = 50
const MAX_ACQUIRE_ATTEMPTS = 100

export class LockTimeoutError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "LockTimeoutError"
    }
}

export interface LockHandle {
    sessionId: string
    lockPath: string
}

interface LockFileContent {
    pid: number
    timestamp: number
}

function getLockPath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json.lock`)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readLockFile(lockPath: string): Promise<LockFileContent | null> {
    let content: string
    try {
        content = await readFile(lockPath, "utf-8")
    } catch {
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(content)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== "object") {
        return null
    }
    const candidate = parsed as Partial<LockFileContent>
    if (
        typeof candidate.pid !== "number" ||
        !Number.isInteger(candidate.pid) ||
        typeof candidate.timestamp !== "number" ||
        !Number.isFinite(candidate.timestamp)
    ) {
        return null
    }
    return { pid: candidate.pid, timestamp: candidate.timestamp }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (err: any) {
        if (err?.code === "ESRCH") {
            return false
        }
        // EPERM (process exists but we lack permission) and any other error are treated
        // as "alive" to avoid mistakenly taking over a live holder's lock.
        return true
    }
}

async function safeUnlink(lockPath: string): Promise<void> {
    try {
        await unlink(lockPath)
    } catch (err: any) {
        // Another process may have already removed the file; treat ENOENT as success.
        if (err?.code !== "ENOENT") {
            throw err
        }
    }
}

async function ensureStorageDir(): Promise<void> {
    await mkdir(STORAGE_DIR, { recursive: true })
}

export async function acquireSessionLock(sessionId: string): Promise<LockHandle> {
    await ensureStorageDir()

    const lockPath = getLockPath(sessionId)

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
        try {
            // "wx" is atomic on POSIX: fails with EEXIST if the path already exists.
            const fileHandle = await open(lockPath, "wx")
            try {
                const content: LockFileContent = {
                    pid: process.pid,
                    timestamp: Date.now(),
                }
                await fileHandle.writeFile(JSON.stringify(content), "utf-8")
            } finally {
                await fileHandle.close()
            }
            return { sessionId, lockPath }
        } catch (err: any) {
            if (err?.code !== "EEXIST") {
                throw err
            }
        }

        // EEXIST: a lock file is present (or appears to be). Decide what to do.
        const existing = await readLockFile(lockPath)

        if (existing) {
            if (!isProcessAlive(existing.pid)) {
                // Holder process is dead -> immediate takeover, no delay.
                await safeUnlink(lockPath)
                continue
            }
            const age = Date.now() - existing.timestamp
            if (age > STALE_LOCK_MS) {
                console.warn(
                    `[dcp] Stale lock detected for session ${sessionId} ` +
                        `(pid=${existing.pid}, age=${age}ms); taking over.`,
                )
                await safeUnlink(lockPath)
                continue
            }
        }

        // Either the lock is valid+fresh, or the file is briefly unreadable/malformed
        // (e.g. another process is mid-write). Wait and retry without taking over.
        await sleep(RETRY_DELAY_MS)
    }

    throw new LockTimeoutError(
        `Timed out acquiring session lock for ${sessionId} ` +
            `after ${MAX_ACQUIRE_ATTEMPTS} attempts ` +
            `(~${(MAX_ACQUIRE_ATTEMPTS * RETRY_DELAY_MS) / 1000}s)`,
    )
}

export async function releaseSessionLock(handle: LockHandle): Promise<void> {
    // Avoid clobbering another process's lock if ours was stolen by a stale takeover.
    const existing = await readLockFile(handle.lockPath)
    if (existing && existing.pid !== process.pid) {
        return
    }
    await safeUnlink(handle.lockPath)
}

export async function withSessionLock<T>(
    sessionId: string,
    fn: () => Promise<T>,
): Promise<T> {
    const handle = await acquireSessionLock(sessionId)
    try {
        return await fn()
    } finally {
        await releaseSessionLock(handle)
    }
}
