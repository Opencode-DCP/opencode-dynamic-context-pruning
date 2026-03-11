declare module "@opencode-ai/plugin/tui" {
    export interface TuiCommand {
        title: string
        value: string
        description?: string
        category?: string
        keybind?: unknown
        slash?: {
            name: string
        }
        onSelect?: () => void
    }

    export interface TuiRouteDefinition<Node = unknown> {
        name: string
        render: (input: { params?: Record<string, unknown> }) => Node
    }

    export interface TuiKeybindSet {
        get: (key: string) => unknown
        match: (key: string, evt: unknown) => boolean
    }

    export interface TuiApi<Node = unknown> {
        command: {
            register: (cb: () => TuiCommand[]) => void
            trigger: (value: string) => void
        }
        route: {
            register: (routes: TuiRouteDefinition<Node>[]) => () => void
            navigate: (name: string, params?: any) => void
            current: {
                name: string
                params?: any
            }
        }
        ui: {
            toast: (input: {
                title: string
                message: string
                variant?: string
                duration?: number
            }) => void
            dialog: {
                open?: boolean
            }
        }
        keybind?: {
            create: (
                defaults: Record<string, unknown>,
                overrides?: Record<string, unknown>,
            ) => TuiKeybindSet
        }
        theme: {
            current: unknown
        }
    }

    export interface TuiPluginInput<
        Renderer extends { requestRender: () => void } = { requestRender: () => void },
        Node = unknown,
    > {
        client: any
        event: {
            on: (name: string, cb: (event: any) => void) => () => void
        }
        renderer: Renderer
        slots: {
            register: (slot: any) => () => void
        }
        api: TuiApi<Node>
    }
}
