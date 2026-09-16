import { createServer } from "node:http"
import { randomUUID } from "node:crypto"

export function events(text = "MOCK_OK", call) {
    const id = `resp_${randomUUID()}`
    const item = {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    }
    const response = {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: "gpt-5.4",
        status: "completed",
        output: [item],
        usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
        },
    }
    if (call) {
        const item = {
            id: `fc_${randomUUID()}`,
            type: "function_call",
            call_id: `call_${randomUUID()}`,
            name: "compress",
            arguments: JSON.stringify(call),
            status: "completed",
        }
        return [
            {
                type: "response.created",
                response: { ...response, status: "in_progress", output: [] },
            },
            {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, status: "in_progress", arguments: "" },
            },
            {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: 0,
                delta: item.arguments,
            },
            {
                type: "response.function_call_arguments.done",
                item_id: item.id,
                output_index: 0,
                arguments: item.arguments,
            },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: { ...response, output: [item] } },
        ].map((event, sequence_number) => ({ ...event, sequence_number }))
    }
    return [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
        },
        {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        },
        {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: text,
        },
        {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            text,
        },
        {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: item.content[0],
        },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
    ].map((event, sequence_number) => ({ ...event, sequence_number }))
}

export async function createMock(WebSocketServer) {
    const requests = []
    function respond(body) {
        const tool = body.tools?.find((tool) => tool.name === "compress")
        const text = JSON.stringify(body.input)
        if (text.includes("You MUST summarize the conversation above"))
            return events("## Objective\nDCP_NATIVE_SUMMARY: preserve the completed test work.")
        if (!tool || text.includes("LAB_SUMMARY") || text.includes("function_call_output"))
            return events()
        const ref = text.match(/<dcp-message-id[^>]*>(m\d+)<\/dcp-message-id>/)?.[1]
        if (!ref) return events("MISSING_DCP_IDS")
        const message = tool.parameters?.properties?.content?.items?.properties?.messageId
        const item = message
            ? { messageId: ref, topic: "Lab", summary: "LAB_SUMMARY" }
            : { startId: ref, endId: ref, summary: "LAB_SUMMARY" }
        return events(undefined, { topic: "Lab", content: [item] })
    }
    const server = createServer(async (request, response) => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())
        requests.push({ transport: "http", body })
        response.writeHead(200, { "content-type": "text/event-stream" })
        for (const event of respond(body))
            response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        response.end()
    })
    const sockets = new WebSocketServer({ server })
    sockets.on("connection", (socket) => {
        socket.on("message", (data) => {
            const body = JSON.parse(data.toString())
            requests.push({ transport: "websocket", body })
            for (const event of respond(body)) socket.send(JSON.stringify(event))
        })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    return {
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        async close() {
            for (const socket of sockets.clients) socket.terminate()
            sockets.close()
            await new Promise((resolve) => server.close(resolve))
        },
    }
}
