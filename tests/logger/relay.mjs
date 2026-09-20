import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { WebSocket, WebSocketServer } from "ws"
import { defaultDirectory, decode } from "./dist/log.js"

// Native V2 exposes a handshake hook, but no hook for the frames themselves.
export function createRelay({ directory = defaultDirectory() } = {}) {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end('{"ok":true}')
    })
    const sockets = new WebSocketServer({ noServer: true })
    const connections = new Set()

    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url, "http://localhost")
        const upstream = url.searchParams.get("upstream")
        if (url.pathname !== "/relay" || !upstream || !/^wss?:\/\//.test(upstream)) {
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return
        }
        const sessionID = url.searchParams.get("session") || "unknown"
        const kind = url.searchParams.get("kind") || "primary"
        const connectionID = randomUUID()
        const folder = join(directory, encodeURIComponent(sessionID))
        const file = join(folder, `${connectionID}.ws.jsonl`)
        let sequence = 0
        function record(event) {
            try {
                mkdirSync(folder, { recursive: true, mode: 0o700 })
                appendFileSync(
                    file,
                    JSON.stringify({
                        timestamp: new Date().toISOString(),
                        sessionID,
                        kind,
                        connectionID,
                        sequence: sequence++,
                        ...event,
                    }) + "\n",
                    { mode: 0o600 },
                )
            } catch (error) {
                console.error("request-logger: cannot record WebSocket", error)
            }
        }
        const headers = Object.fromEntries(
            Object.entries(request.headers).filter(
                ([key]) =>
                    !["host", "connection", "upgrade"].includes(key) &&
                    !key.startsWith("sec-websocket-"),
            ),
        )
        const protocols = request.headers["sec-websocket-protocol"]
            ?.split(",")
            .map((item) => item.trim())
        const remote = new WebSocket(upstream, protocols, { headers })
        connections.add(remote)
        let local
        const close = (target, code, reason) => {
            if (!target || target.readyState === WebSocket.CLOSED) return
            if ([1005, 1006, 1015].includes(code)) target.terminate()
            else target.close(code, reason)
        }
        const forward = (from, to, direction) => (data, binary) => {
            record({
                type: "ws.frame",
                direction,
                binary,
                body: binary ? data.toString("base64") : decode(data.toString()),
            })
            from.pause()
            to.send(data, { binary }, (error) => {
                if (error) {
                    record({ type: "ws.error", direction, message: error.message })
                    from.terminate()
                    to.terminate()
                } else from.resume()
            })
        }
        remote.on("open", () => {
            sockets.handleUpgrade(request, socket, head, (client) => {
                local = client
                connections.add(client)
                record({ type: "ws.open", url: upstream })
                client.on("message", forward(client, remote, "request"))
                remote.on("message", forward(remote, client, "response"))
                client.on("error", (error) => {
                    record({ type: "ws.error", direction: "request", message: error.message })
                    remote.terminate()
                })
                client.on("close", (code, reason) => {
                    connections.delete(client)
                    record({
                        type: "ws.close",
                        direction: "request",
                        code,
                        reason: reason.toString(),
                    })
                    close(remote, code, reason)
                })
            })
        })
        remote.on("unexpected-response", (_req, response) => {
            record({ type: "ws.rejected", status: response.statusCode })
            socket.write(
                `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`,
            )
            response.pipe(socket)
            connections.delete(remote)
        })
        remote.on("error", (error) => {
            record({ type: "ws.error", direction: "response", message: error.message })
            if (local) local.terminate()
            else socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
        })
        remote.on("close", (code, reason) => {
            connections.delete(remote)
            record({ type: "ws.close", direction: "response", code, reason: reason.toString() })
            close(local, code, reason)
        })
        socket.on("error", () => remote.terminate())
    })
    return {
        server,
        async close() {
            for (const socket of connections) socket.terminate()
            sockets.close()
            await new Promise((resolve) => server.close(resolve))
        },
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const relay = createRelay()
    relay.server.listen(Number(process.env.PORT || 4097), process.env.HOST || "127.0.0.1", () => {
        console.log(`request-logger relay listening on ${JSON.stringify(relay.server.address())}`)
    })
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void relay.close())
}
