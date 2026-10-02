import { execFile } from "node:child_process";
import { z } from "zod";
import { assertToolParamStates, toolDescription, toolParam } from "@magentra/protocol";
import type { ToolDefinition, ToolResult } from "@magentra/core";

const MAX_MESSAGE_CHARS = 200;
// message's text in brain states MAX_MESSAGE_CHARS; the import fails if the two drift apart.
assertToolParamStates("PushNotification", "message", `Truncated to ${MAX_MESSAGE_CHARS} characters.`);

const inputSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe(toolParam("PushNotification", "message")),
  status: z
    .literal("proactive")
    .describe(toolParam("PushNotification", "status")),
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
 * a protocol signal frontends receive when a background job completes,
 * owned by BackgroundManager in core.
 */
export const pushNotificationTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "PushNotification",
  description: toolDescription("PushNotification"),
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
