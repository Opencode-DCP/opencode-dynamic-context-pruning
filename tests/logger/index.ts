import type { Plugin } from "@opencode/plugin"
import { server } from "./v1.js"
import { setup } from "./v2.js"

// Type-only V2 imports keep the shared entrypoint loadable in V1.
export default {
    id: "opencode-request-logger",
    setup,
    server,
} satisfies Plugin.Plugin & { server: typeof server }
