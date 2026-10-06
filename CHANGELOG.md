# Changelog

## 0.1.3

- Export `ToolUsageError` for intentionally public correction instructions.
- Give actionable input-schema validation hints without echoing supplied values.
- Preserve bounded MCP server error text as tool feedback.

Errors still require corrected arguments or an explicit host decision; these changes do not
authorize unchanged retries or repeated side effects.
