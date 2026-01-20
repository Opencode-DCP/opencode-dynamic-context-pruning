export interface SubAgentSessionInfo {
    isSubAgent: boolean
    parentID: string | null
    systemPrompt: string | null
}

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

export async function getSubAgentSessionInfo(
    client: any,
    sessionID: string,
): Promise<SubAgentSessionInfo> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        const isSubAgent = !!result.data?.parentID
        const parentID = result.data?.parentID || null

        // Get system prompt from session if available
        let systemPrompt: string | null = null
        if (isSubAgent && result.data?.system) {
            // system can be a string or array of strings
            if (Array.isArray(result.data.system)) {
                systemPrompt = result.data.system.join("\n")
            } else if (typeof result.data.system === "string") {
                systemPrompt = result.data.system
            }
        }

        return { isSubAgent, parentID, systemPrompt }
    } catch (error: any) {
        return { isSubAgent: false, parentID: null, systemPrompt: null }
    }
}
