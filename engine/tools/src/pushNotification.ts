import { execFile } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@magentra/core";

const MAX_MESSAGE_CHARS = 200;

const inputSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe(`The notification text. Truncated to ${MAX_MESSAGE_CHARS} characters.`),
  status: z
    .literal("proactive")
    .describe('Always "proactive" — this signals an unprompted, attention-worthy notification.'),
});

/**
 * Delivers an OS notification. Boring, per-platform shell-outs; arguments are
 * passed via execFile args (never string-interpolated into a shell) so message
 * content cannot inject. Never fails the agent loop: any delivery problem
 * resolves with a plain (non-error) note.
 *
 * Naming disambiguation: this tool is unrelated to the `background_notification`
 * CoreEvent despite the similar name. This one raises a desktop toast for the
 * human (notify-send/osascript/PowerShell) and emits NO CoreEvent; that one is
 * a protocol signal frontends receive when a background job or mission run
 * completes, owned by BackgroundManager and the mission runner in core.
 */
export const pushNotificationTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "PushNotification",
  description: `Sends a proactive OS notification to get the user's attention (e.g. a long task finished, or input is needed).

Use sparingly for genuinely notification-worthy moments. Delivery is best-effort and platform-dependent; it never interrupts or fails the current work.`,
  permissionClass: "interact",
  describeInput: (input) => `notify: ${input.message.slice(0, 60)}`,
  execute: async (input): Promise<ToolResult> => {
    const message = input.message.slice(0, MAX_MESSAGE_CHARS);
    const delivered = await deliver(message);
    return {
      content: delivered
        ? `Notification sent: "${message}"`
        : `Notification could not be delivered (expected on some systems). Message was: "${message}"`,
    };
  },
  inputSchema,
};

function deliver(message: string): Promise<boolean> {
  switch (process.platform) {
    case "win32":
      return runWindows(message);
    case "darwin":
      return run("osascript", ["-e", `display notification ${appleScriptString(message)} with title "Magentra"`]);
    default:
      return run("notify-send", ["Magentra", message]);
  }
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((res) => {
    try {
      execFile(command, args, { timeout: 10_000, ...(env ? { env } : {}) }, (err) => res(!err));
    } catch {
      res(false);
    }
  });
}

function runWindows(message: string): Promise<boolean> {
  // Message is passed via an env var and read as $env:MAGENTRA_NOTIFY_MSG so it
  // is never interpolated into the PowerShell source (no injection).
  const script = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $xml.GetElementsByTagName('text')
  $texts.Item(0).AppendChild($xml.CreateTextNode('Magentra')) > $null
  $texts.Item(1).AppendChild($xml.CreateTextNode($env:MAGENTRA_NOTIFY_MSG)) > $null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Magentra').Show($toast)
} catch {
  exit 1
}`;
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    ...process.env,
    MAGENTRA_NOTIFY_MSG: message,
  });
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
