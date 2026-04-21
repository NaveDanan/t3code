import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  shouldShowCompletionSummary,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.make(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.make("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.make("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.make("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.make("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.make("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.make("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.make("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("extracts generated activity group titles", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "tool-complete",
          summary: "Run command",
          kind: "tool.completed",
          payload: {
            title: "Run command",
            activityGroupTitle: "Inspect package scripts",
          },
        }),
      ],
      undefined,
    );

    expect(entries[0]?.groupTitle).toBe("Inspect package scripts");
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.make("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("extracts Forge-style command input payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "forge-command-tool",
        kind: "tool.completed",
        summary: "Command run",
        payload: {
          itemType: "command_execution",
          title: "Command run",
          detail: "bun run lint",
          data: {
            input: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    );
  });

  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper-argv",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it("extracts command text from command detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-detail-fallback",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail:
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });

  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-shell-script",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "bash script.sh",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("extracts Forge-style changed file paths from tool args", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "forge-file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "File change",
          detail: "apps/web/src/components/ChatView.tsx",
          data: {
            input: {
              filePath: "apps/web/src/components/ChatView.tsx",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["apps/web/src/components/ChatView.tsx"]);
  });

  it("extracts Claude-style edit stats from snake_case tool input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-edit-tool",
        kind: "tool.updated",
        summary: "Edit",
        payload: {
          itemId: "claude-edit-1",
          itemType: "file_change",
          title: "Edit",
          data: {
            toolName: "Edit",
            input: {
              file_path: "src/claude.ts",
              old_string: "const value = 1;",
              new_string: "const value = 1;\nconst nextValue = 2;",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["src/claude.ts"]);
    expect(entry?.changedFileStats).toEqual([
      { path: "src/claude.ts", additions: 2, deletions: 1, status: "modified" },
    ]);
  });

  it("sums Claude-style MultiEdit line stats from parent file_path", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "claude-multiedit-tool",
        kind: "tool.updated",
        summary: "MultiEdit",
        payload: {
          itemId: "claude-multiedit-1",
          itemType: "file_change",
          title: "MultiEdit",
          data: {
            toolName: "MultiEdit",
            input: {
              file_path: "src/multi.ts",
              edits: [
                {
                  old_string: "alpha",
                  new_string: "alpha\nbeta",
                },
                {
                  old_string: "gamma\ndelta",
                  new_string: "gamma",
                },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["src/multi.ts"]);
    expect(entry?.changedFileStats).toEqual([
      { path: "src/multi.ts", additions: 3, deletions: 3, status: "modified" },
    ]);
  });

  it("extracts OpenCode in-progress edit stats from nested tool state input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "opencode-edit-tool",
        kind: "tool.updated",
        summary: "edit",
        payload: {
          itemId: "opencode-edit-1",
          itemType: "file_change",
          title: "edit",
          data: {
            id: "opencode-part-1",
            tool: "edit",
            state: {
              status: "running",
              input: {
                filePath: "src/open.ts",
                oldString: "before",
                newString: "after\nnext",
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["src/open.ts"]);
    expect(entry?.changedFileStats).toEqual([
      { path: "src/open.ts", additions: 2, deletions: 1, status: "modified" },
    ]);
  });

  it("extracts Forge-style file content stats from snake_case tool args", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "forge-write-tool",
        kind: "tool.updated",
        summary: "WriteFile",
        payload: {
          itemId: "forge-write-1",
          itemType: "file_change",
          title: "WriteFile",
          data: {
            toolName: "WriteFile",
            callId: "forge-call-1",
            input: {
              file_path: "src/forge.ts",
              content: "one\ntwo",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["src/forge.ts"]);
    expect(entry?.changedFileStats).toEqual([
      { path: "src/forge.ts", additions: 2, deletions: 0, status: "modified" },
    ]);
  });

  it("extracts changed file paths from apply_patch marker text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "patch-tool",
        kind: "tool.completed",
        summary: "Apply patch",
        payload: {
          itemType: "file_change",
          data: {
            patchText: [
              "*** Begin Patch",
              "*** Add File: src/new-file.ts",
              "+export const value = 1;",
              "*** Update File: src/old.ts",
              "*** Move to: src/new.ts",
              "*** Delete File: src/obsolete.ts",
              "*** End Patch",
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["src/new-file.ts", "src/new.ts", "src/obsolete.ts"]);
    expect(entry?.changedFileStats).toEqual([
      { path: "src/new-file.ts", additions: 1, deletions: 0, status: "added" },
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        additions: 0,
        deletions: 0,
        status: "moved",
      },
      { path: "src/obsolete.ts", additions: 0, deletions: 0, status: "deleted" },
    ]);
  });

  it("extracts changed file paths from unified diff payload text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "diff-tool",
        kind: "tool.completed",
        summary: "Apply patch",
        payload: {
          itemType: "file_change",
          data: {
            diff: [
              "diff --git a/src/alpha.ts b/src/alpha.ts",
              "index 1111111..2222222 100644",
              "--- a/src/alpha.ts",
              "+++ b/src/alpha.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
              "diff --git a/src/created.ts b/src/created.ts",
              "new file mode 100644",
              "--- /dev/null",
              "+++ b/src/created.ts",
              "@@ -0,0 +1 @@",
              "+created",
              "",
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["src/alpha.ts", "src/created.ts"]);
    expect(entry?.changedFileStats).toEqual([
      { path: "src/alpha.ts", additions: 1, deletions: 1, status: "modified" },
      { path: "src/created.ts", additions: 1, deletions: 0, status: "added" },
    ]);
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("collapses file-change lifecycle rows by item id and keeps in-progress file stats", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Edit",
        payload: {
          itemId: "item-edit-1",
          itemType: "file_change",
          title: "Edit",
          detail: "Editing src/catalog.test.ts",
          data: {
            patchText: [
              "*** Begin Patch",
              "*** Update File: src/catalog.test.ts",
              "-old",
              "+new",
              "+extra",
              "*** End Patch",
            ].join("\n"),
          },
        },
      }),
      makeActivity({
        id: "file-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Edit",
        payload: {
          itemId: "item-edit-1",
          itemType: "file_change",
          title: "Edit",
          detail: "Edit applied successfully.",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "file-complete",
      itemId: "item-edit-1",
      detail: "Edit applied successfully.",
      changedFiles: ["src/catalog.test.ts"],
      changedFileStats: [
        { path: "src/catalog.test.ts", additions: 2, deletions: 1, status: "modified" },
      ],
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });

  it("attaches a live turn diff to the last file-change entry in the turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Apply patch",
        turnId: "turn-1",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [{ path: "apps/web/src/session-logic.ts" }],
            },
          },
        },
      }),
      makeActivity({
        id: "file-tool-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Apply patch",
        turnId: "turn-1",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [{ path: "apps/web/src/components/ChatView.tsx" }],
            },
          },
        },
      }),
      makeActivity({
        id: "turn-diff",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "turn.diff.updated",
        summary: "Turn diff updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          unifiedDiff:
            "diff --git a/apps/web/src/components/ChatView.tsx b/apps/web/src/components/ChatView.tsx\n+hello\n",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.unifiedDiff).toBeUndefined();
    expect(entries[1]?.unifiedDiff).toContain("diff --git");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.make("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.make("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.make("turn-2"))).toBe(false);
  });
});

describe("shouldShowCompletionSummary", () => {
  const completedTurn = {
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
    assistantMessageId: MessageId.make("assistant:turn-1"),
  } as const;

  it("shows the summary for settled turns with tool activity", () => {
    expect(
      shouldShowCompletionSummary({
        latestTurnSettled: true,
        latestTurn: completedTurn,
        hasToolActivity: true,
        hasAssistantResponse: false,
        provider: "codex",
      }),
    ).toBe(true);
  });

  it("shows the summary for settled opencode turns once an assistant response completes", () => {
    expect(
      shouldShowCompletionSummary({
        latestTurnSettled: true,
        latestTurn: completedTurn,
        hasToolActivity: false,
        hasAssistantResponse: true,
        provider: "opencode",
      }),
    ).toBe(true);
  });

  it("shows the summary for settled forgecode turns once an assistant response completes", () => {
    expect(
      shouldShowCompletionSummary({
        latestTurnSettled: true,
        latestTurn: completedTurn,
        hasToolActivity: false,
        hasAssistantResponse: true,
        provider: "forgecode",
      }),
    ).toBe(true);
  });

  it("keeps the summary hidden for other providers without tool activity", () => {
    expect(
      shouldShowCompletionSummary({
        latestTurnSettled: true,
        latestTurn: completedTurn,
        hasToolActivity: false,
        hasAssistantResponse: true,
        provider: "codex",
      }),
    ).toBe(false);
  });

  it("keeps the summary hidden for opencode before an assistant response exists", () => {
    expect(
      shouldShowCompletionSummary({
        latestTurnSettled: true,
        latestTurn: {
          ...completedTurn,
          assistantMessageId: null,
        },
        hasToolActivity: false,
        hasAssistantResponse: false,
        provider: "opencode",
      }),
    ).toBe(false);
  });

  it("shows the summary for opencode when the response exists but the assistant message id is missing", () => {
    expect(
      shouldShowCompletionSummary({
        latestTurnSettled: true,
        latestTurn: {
          ...completedTurn,
          assistantMessageId: null,
        },
        hasToolActivity: false,
        hasAssistantResponse: true,
        provider: "opencode",
      }),
    ).toBe(true);
  });

  it("shows the summary for forgecode when the response exists but the assistant message id is missing", () => {
    expect(
      shouldShowCompletionSummary({
        latestTurnSettled: true,
        latestTurn: {
          ...completedTurn,
          assistantMessageId: null,
        },
        hasToolActivity: false,
        hasAssistantResponse: true,
        provider: "forgecode",
      }),
    ).toBe(true);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises active providers while keeping Cursor as a placeholder", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const forge = PROVIDER_OPTIONS.find((option) => option.value === "forgecode");
    const opencode = PROVIDER_OPTIONS.find((option) => option.value === "opencode");
    const githubCopilot = PROVIDER_OPTIONS.find((option) => option.value === "githubCopilot");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "opencode", label: "OpenCode", available: true },
      { value: "forgecode", label: "ForgeCode", available: true },
      { value: "githubCopilot", label: "GitHub Copilot", available: true },
      { value: "cursor", label: "Cursor", available: false },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(forge).toEqual({
      value: "forgecode",
      label: "ForgeCode",
      available: true,
    });
    expect(opencode).toEqual({
      value: "opencode",
      label: "OpenCode",
      available: true,
    });
    expect(githubCopilot).toEqual({
      value: "githubCopilot",
      label: "GitHub Copilot",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: false,
    });
  });
});
