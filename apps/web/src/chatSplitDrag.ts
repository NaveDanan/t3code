import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

export const CHAT_THREAD_DRAG_MIME_TYPE = "application/x-t3code-thread-ref";

interface ThreadDragPayload {
  environmentId: string;
  threadId: string;
}

export function encodeThreadDragPayload(threadRef: ScopedThreadRef): string {
  return JSON.stringify({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  } satisfies ThreadDragPayload);
}

export function writeThreadDragPayload(
  dataTransfer: DataTransfer,
  threadRef: ScopedThreadRef,
): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CHAT_THREAD_DRAG_MIME_TYPE, encodeThreadDragPayload(threadRef));
  dataTransfer.setData("text/plain", threadRef.threadId);
}

export function decodeThreadDragPayload(dataTransfer: DataTransfer): ScopedThreadRef | null {
  const rawPayload = dataTransfer.getData(CHAT_THREAD_DRAG_MIME_TYPE);
  if (!rawPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(rawPayload) as Partial<ThreadDragPayload>;
    if (!payload.environmentId || !payload.threadId) {
      return null;
    }
    return scopeThreadRef(payload.environmentId as EnvironmentId, payload.threadId as ThreadId);
  } catch {
    return null;
  }
}

export function hasThreadDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(CHAT_THREAD_DRAG_MIME_TYPE);
}
