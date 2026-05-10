// These format schemas are kept separate from the editable compress prompts
// so they cannot be modified via custom prompt overrides. The schemas must
// match the tool's input validation and are not safe to change independently.

export function getRangeFormatExtension(delegated: boolean) {
    return `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: mNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNN or bN
      summary: string      // ${delegated ? "Omit this field. DCP will generate the summary." : "Complete technical summary replacing all content in range"}
    }
  ]
}
\`\`\``
}

export function getMessageFormatExtension(delegated: boolean) {
    return `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: mNNNN (ignore metadata attributes like priority)
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // ${delegated ? "Omit this field. DCP will generate the summary." : "Complete technical summary replacing that one message"}
    }
  ]
}
\`\`\``
}
