// These format schemas are kept separate from the editable compress prompts
// so they cannot be modified via custom prompt overrides. The schemas must
// match the tool's input validation and are not safe to change independently.

import type { IdFormat } from "../../message-ids"

export function rangeFormat(format: IdFormat = "xml"): string {
    const ids = format === "compact" ? "@4@ or @b1@ (include both @ characters)" : "mNNNN or bN"
    return `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: ${ids}
      endId: string,       // Boundary ID at range end: ${ids}
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\``
}

export function messageFormat(format: IdFormat = "xml"): string {
    const ids =
        format === "compact"
            ? "@4@ (include both @ characters; omit priority labels)"
            : "mNNNN (ignore metadata attributes like priority)"
    return `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: ${ids}
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // Complete technical summary replacing that one message
    }
  ]
}
\`\`\``
}

export const RANGE_FORMAT_EXTENSION = rangeFormat()
export const MESSAGE_FORMAT_EXTENSION = messageFormat()
