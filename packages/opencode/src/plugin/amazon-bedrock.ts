import type { Hooks, PluginInput } from "@opencode-ai/plugin"

export async function AmazonBedrockAuthPlugin(_input: PluginInput): Promise<Hooks> {
  const prompts = !process.env.AWS_REGION
    ? [
        {
          type: "text" as const,
          key: "region",
          message: "Enter your AWS region for Bedrock",
          placeholder: "e.g. us-east-1",
          validate: (value: string) => (value.length > 0 ? undefined : "Required"),
        },
      ]
    : []

  return {
    auth: {
      provider: "amazon-bedrock",
      methods: [
        {
          type: "api",
          label: "Bedrock API key",
          prompts,
        },
      ],
    },
  }
}
