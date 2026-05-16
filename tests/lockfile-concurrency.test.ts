import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"

const testDataHome = join(tmpdir(), `opencode-dcp-lock-concurrency-tests-${process.pid}`)
const testConfigHome = join(
    tmpdir(),
    `opencode-dcp-lock-concurrency-config-tests-${process.pid}`,
)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

// `lib/state/lock.ts` captures `process.env.XDG_DATA_HOME` at module load time
// into the module-level `STORAGE_DIR` constant. The env var assignment above
// must therefore run BEFORE the module is evaluated, which means we must use a
// dynamic `await import` here instead of a static top-level `import` (mirrors
// the runtime probes in .sisyphus/drafts/lock-{serialize,stale}-probe.mts).
const { acquireSessionLock, releaseSessionLock, withSessionLock } = await import(
    "../lib/state/lock"
)

const STORAGE_DIR = join(testDataHome, "opencode", "storage", "plugin", "dcp")

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockPathFor(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json.lock`)
}

test(
    "two concurrent acquires on the same lock path serialize",
    { timeout: 15_000 },
    async () => {
        const sessionId = "ses_t19_concurrent"

        const acquireHoldRelease = async (
            label: string,
            holdMs: number,
        ): Promise<{
            label: string
            acquireFinishedAt: number
            releasedAt: number
        }> => {
            const handle = await acquireSessionLock(sessionId)
            const acquireFinishedAt = Date.now()
            await sleep(holdMs)
            await releaseSessionLock(handle)
            const releasedAt = Date.now()
            return { label, acquireFinishedAt, releasedAt }
        }

        // Both promises start simultaneously and race for the lock. lock.ts
        // uses POSIX-atomic `open(path, "wx")` so exactly one wins each retry
        // round; the other gets EEXIST and waits in the 50ms retry loop until
        // the holder releases.
        const results = await Promise.all([
            acquireHoldRelease("A", 100),
            acquireHoldRelease("B", 100),
        ])

        assert.equal(results.length, 2, "both acquires must return a handle")

        // Identify acquisition order by the timestamp captured just after each
        // `await acquireSessionLock(...)` resolves.
        const [first, second] = [...results].sort(
            (x, y) => x.acquireFinishedAt - y.acquireFinishedAt,
        )

        assert.ok(
            second.acquireFinishedAt >= first.releasedAt,
            `serialization violated: ${first.label} released at ${first.releasedAt}ms, ` +
                `${second.label} acquired at ${second.acquireFinishedAt}ms ` +
                `(second must not acquire while first still holds the lock)`,
        )

        assert.equal(
            existsSync(lockPathFor(sessionId)),
            false,
            "lock file should be removed after both releases",
        )
    },
)

test(
    "stale lock from a dead PID is taken over quickly (no 30s wait)",
    { timeout: 15_000 },
    async () => {
        const sessionId = "ses_t19_dead_pid"
        const deadPid = 9_999_999

        // Sanity check that the planted PID is actually dead. If a real
        // process happened to own this PID, the test would silently degrade
        // into a 30s age-based takeover. ESRCH from kill(pid, 0) is the only
        // signal lock.ts uses to short-circuit the age check.
        try {
            process.kill(deadPid, 0)
            assert.fail(
                `PID ${deadPid} is unexpectedly alive; pick a different probe PID`,
            )
        } catch (err: any) {
            assert.equal(
                err?.code,
                "ESRCH",
                `expected ESRCH from kill(${deadPid}, 0); got code=${err?.code}`,
            )
        }

        // Plant a lockfile owned by the dead PID with a FRESH timestamp.
        // If takeover relied solely on `Date.now() - timestamp > 30_000`, this
        // setup would force the acquire loop to retry for ~5s and then throw
        // LockTimeoutError. The ESRCH branch in lock.ts must win first.
        mkdirSync(STORAGE_DIR, { recursive: true })
        const lockPath = lockPathFor(sessionId)
        writeFileSync(
            lockPath,
            JSON.stringify({ pid: deadPid, timestamp: Date.now() }),
            "utf-8",
        )

        const t0 = Date.now()
        const handle = await acquireSessionLock(sessionId)
        const elapsed = Date.now() - t0

        assert.ok(
            elapsed < 1000,
            `acquireSessionLock took ${elapsed}ms; expected < 1000ms ` +
                `(ESRCH must bypass the 30s age check for dead PIDs)`,
        )

        await releaseSessionLock(handle)
        assert.equal(
            existsSync(lockPath),
            false,
            "lock file should be removed after release",
        )
    },
)

test(
    "withSessionLock cleans up the lock file after success and after throw",
    { timeout: 15_000 },
    async () => {
        const sessionId = "ses_t19_cleanup"
        const lockPath = lockPathFor(sessionId)

        // --- Success path: fn resolves, finally must release ---
        const result = await withSessionLock(sessionId, async () => {
            assert.equal(
                existsSync(lockPath),
                true,
                "lock file should exist while inside the critical section (success case)",
            )
            return "ok"
        })
        assert.equal(result, "ok", "withSessionLock should forward fn's resolved value")
        assert.equal(
            existsSync(lockPath),
            false,
            "lock file should be removed after withSessionLock resolves (success)",
        )

        // --- Error path: fn throws, finally must STILL release ---
        await assert.rejects(
            withSessionLock(sessionId, async () => {
                assert.equal(
                    existsSync(lockPath),
                    true,
                    "lock file should exist while inside the critical section (throw case)",
                )
                throw new Error("boom from critical section")
            }),
            /boom from critical section/,
            "withSessionLock should re-throw fn's error",
        )
        assert.equal(
            existsSync(lockPath),
            false,
            "lock file should be removed after withSessionLock throws",
        )

        // Cleanup verified twice in a row — proves a follow-up acquire can take
        // ownership immediately because the previous handle was released.
        const reacquired = await acquireSessionLock(sessionId)
        await releaseSessionLock(reacquired)
        assert.equal(
            existsSync(lockPath),
            false,
            "lock file should be removed after the follow-up acquire/release cycle",
        )
    },
)
