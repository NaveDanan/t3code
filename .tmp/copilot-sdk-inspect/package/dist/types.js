function defineTool(name, config) {
  return { name, ...config };
}
const SYSTEM_PROMPT_SECTIONS = {
  identity: { description: "Agent identity preamble and mode statement" },
  tone: { description: "Response style, conciseness rules, output formatting preferences" },
  tool_efficiency: { description: "Tool usage patterns, parallel calling, batching guidelines" },
  environment_context: { description: "CWD, OS, git root, directory listing, available tools" },
  code_change_rules: { description: "Coding rules, linting/testing, ecosystem tools, style" },
  guidelines: { description: "Tips, behavioral best practices, behavioral guidelines" },
  safety: { description: "Environment limitations, prohibited actions, security policies" },
  tool_instructions: { description: "Per-tool usage instructions" },
  custom_instructions: { description: "Repository and organization custom instructions" },
  last_instructions: {
    description: "End-of-prompt instructions: parallel tool calling, persistence, task completion"
  }
};
const approveAll = () => ({ kind: "approved" });
export {
  SYSTEM_PROMPT_SECTIONS,
  approveAll,
  defineTool
};
