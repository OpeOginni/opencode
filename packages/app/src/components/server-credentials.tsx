import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { serverDisplayName } from "@/context/server"

interface ServerCredentialsProps {
  url: string
  username: string
  password: string
  error: string
  busy: boolean
  onSubmit: (event: SubmitEvent) => void
  onCancel: () => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
}

export function ServerCredentials(props: ServerCredentialsProps) {
  return (
    <div class="flex flex-col gap-4 py-4">
      <form onSubmit={props.onSubmit} class="flex flex-col gap-4 px-4">
        <TextField
          type="text"
          label="Username"
          hideLabel
          placeholder="Username"
          value={props.username}
          onChange={props.onUsernameChange}
          autofocus
        />
        <TextField
          type="password"
          label="Password"
          hideLabel
          placeholder="Password"
          value={props.password}
          onChange={props.onPasswordChange}
          validationState={props.error ? "invalid" : "valid"}
          error={props.error}
        />
        <div class="flex items-center gap-2 pt-2">
          <Button type="submit" variant="primary" size="large" disabled={props.busy} class="px-3 py-4">
            {props.busy ? "Connecting..." : "Connect"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="large"
            onClick={props.onCancel}
            disabled={props.busy}
            class="px-3 py-4"
          >
            Back
          </Button>
        </div>
      </form>
    </div>
  )
}
