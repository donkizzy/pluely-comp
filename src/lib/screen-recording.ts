/**
 * macOS Screen Recording (TCC) helpers.
 *
 * `checkScreenRecordingPermission()` (CGPreflightScreenCaptureAccess) can
 * false-negative — notably under `tauri dev`, where macOS attributes the
 * permission to the launching app (Cursor / Terminal / iTerm) rather than the
 * debug binary. So we request access but never hard-fail on preflight alone;
 * the native capture (ScreenCaptureKit) reports a real denial.
 */

export const SCREEN_RECORDING_PERMISSION_MESSAGE =
  "Screen Recording permission required. Open System Settings > Privacy & Security > Screen & System Audio Recording and enable Pluely (click '+' to add it if it's missing). If you're running `npm run tauri dev`, enable the app that launched it instead (Cursor, Terminal or iTerm), fully quit and reopen it, then try again.";

const isMac = () => navigator.platform.toLowerCase().includes("mac");

/**
 * Checks Screen Recording permission and requests it if missing. Always
 * resolves; callers should still attempt the capture afterwards.
 */
export async function ensureScreenRecordingPermission(): Promise<void> {
  if (!isMac()) return;
  try {
    const {
      checkScreenRecordingPermission,
      requestScreenRecordingPermission,
    } = await import("tauri-plugin-macos-permissions-api");

    const hasPermission = await checkScreenRecordingPermission();
    console.log(
      "[ScreenRecording] checkScreenRecordingPermission:",
      hasPermission
    );

    if (!hasPermission) {
      await requestScreenRecordingPermission();
      console.log(
        "[ScreenRecording] requested permission; proceeding to attempt capture (preflight can false-negative)"
      );
    }
  } catch (error) {
    console.warn("[ScreenRecording] permission check failed:", error);
  }
}

/** True when a capture error looks like a Screen Recording / TCC denial. */
export function isScreenRecordingPermissionError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  return /screen recording|permission|not authori[sz]ed|declined|TCC/i.test(
    message
  );
}
