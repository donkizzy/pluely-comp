import { useEffect, type ReactNode, type Ref } from "react";
import { Input, Textarea, Button } from "@/components";
export function Field({
  label,
  value,
  onChange,
  multiline = false,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      ) : (
        <Input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
export function Panel({
  title,
  children,
  ref,
}: {
  title: string;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <section
      ref={ref}
      className="rounded-xl border bg-card p-5 space-y-4 scroll-mt-4"
    >
      <h2 className="font-semibold text-lg">{title}</h2>
      {children}
    </section>
  );
}
export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
export function Action({
  children,
  onClick,
  busy = false,
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <Button variant="outline" disabled={busy} onClick={onClick}>
      {children}
    </Button>
  );
}
/**
 * Page messages pinned to the bottom of the window, so the result of an action
 * is visible wherever the page is scrolled. Errors stay until dismissed;
 * confirmations clear themselves.
 */
export function StatusToast({
  error,
  notice,
  onDismiss,
}: {
  error: string;
  notice: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (error || !notice) return;
    const timer = setTimeout(onDismiss, 6000);
    return () => clearTimeout(timer);
  }, [error, notice]);
  const message = error || notice;
  if (!message) return null;
  return (
    <div
      role={error ? "alert" : "status"}
      className={`fixed bottom-6 left-1/2 z-50 flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-lg border p-4 text-sm shadow-lg ${
        error
          ? "border-destructive bg-background text-destructive"
          : "bg-background text-foreground"
      }`}
    >
      <span className="flex-1">{message}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={onDismiss}
        aria-label="Dismiss message"
      >
        Dismiss
      </Button>
    </div>
  );
}
