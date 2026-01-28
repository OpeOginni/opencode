import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"

interface ServerCredentialsFormProps {
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

export function ServerCredentialsForm(props: ServerCredentialsFormProps) {
  return (
    <div class="flex flex-col gap-4 py-4">
      <form onSubmit={props.onSubmit} class="flex flex-col gap-3 px-5 w-full max-w-sm mx-auto">
        <TextField
          type="text"
          label="Username"
          hideLabel
          placeholder="Username"
          value={props.username}
          onChange={props.onUsernameChange}
          autofocus
          disabled={props.busy}
          autocomplete="username"
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
          disabled={props.busy}
          autocomplete="current-password"
        />
        <div class="flex items-center gap-2 pt-2">
          <Button type="submit" variant="primary" size="large" disabled={props.busy} class="px-3 py-2">
            {props.busy ? "Connecting..." : "Connect"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="large"
            onClick={props.onCancel}
            disabled={props.busy}
            class="px-3 py-2"
          >
            Back
          </Button>
        </div>
      </form>
    </div>
  )
}
