import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CHAT_THREAD_DRAG_MIME_TYPE,
  decodeThreadDragPayload,
  hasThreadDragPayload,
  writeThreadDragPayload,
} from "./chatSplitDrag";

class FakeDataTransfer {
  effectAllowed = "uninitialized";
  dropEffect = "none";
  private values = new Map<string, string>();

  get types(): string[] {
    return [...this.values.keys()];
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  getData(type: string): string {
    return this.values.get(type) ?? "";
  }
}

function dataTransfer() {
  return new FakeDataTransfer() as unknown as DataTransfer;
}

function threadRef(): ScopedThreadRef {
  return scopeThreadRef("env-1" as EnvironmentId, "thread-1" as ThreadId);
}

describe("chatSplitDrag", () => {
  it("writes and decodes a thread drag payload", () => {
    const transfer = dataTransfer();

    writeThreadDragPayload(transfer, threadRef());

    expect(hasThreadDragPayload(transfer)).toBe(true);
    expect(transfer.getData(CHAT_THREAD_DRAG_MIME_TYPE)).toContain("thread-1");
    expect(decodeThreadDragPayload(transfer)).toEqual(threadRef());
  });

  it("rejects missing and invalid payloads", () => {
    const missing = dataTransfer();
    expect(hasThreadDragPayload(missing)).toBe(false);
    expect(decodeThreadDragPayload(missing)).toBeNull();

    const invalid = dataTransfer();
    invalid.setData(CHAT_THREAD_DRAG_MIME_TYPE, "{");
    expect(hasThreadDragPayload(invalid)).toBe(true);
    expect(decodeThreadDragPayload(invalid)).toBeNull();
  });
});
