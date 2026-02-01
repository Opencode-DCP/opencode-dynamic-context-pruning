export function isSecureMode(): boolean {
    return !!process.env.OPENCODE_SERVER_PASSWORD
}

export function getAuthorizationHeader(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    if (!password) return undefined

    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
    // Use Buffer for Node.js base64 encoding (btoa may not be available in all Node versions)
    const credentials = Buffer.from(`${username}:${password}`).toString("base64")
    return `Basic ${credentials}`
}

export function configureClientAuth(client: any): any {
    const authHeader = getAuthorizationHeader()

    if (!authHeader) {
        return client
    }

    // The SDK client has an internal client with request interceptors
    // Access the underlying client to add the interceptor
    const innerClient = client._client || client.client

    if (innerClient?.interceptors?.request) {
        innerClient.interceptors.request.use((request: Request) => {
            // Only add auth header if not already present
            if (!request.headers.has("Authorization")) {
                request.headers.set("Authorization", authHeader)
            }
            return request
        })
    }

    return client
}
