# Project Goal — Intake Bots

## Mission
Turn player support reports posted in Discord forums into actionable, correctly routed development issues with minimal manual triage, while preserving a clear communication loop between reporters and maintainers.

## Operational Workflow
A scheduled poller should discover new reports, identify the intended project from explicit tags, and create or update the corresponding issue in the appropriate repository. Replies from maintainers should reach the original discussion, and reporters should receive meaningful release notifications when fixes ship. Unrouted reports should receive a helpful request for the missing classification rather than disappear.

## Product Scope
Provide a lightweight, reliable automation service for polling Discord ticket forums, routing reports to project repositories, handling maintainer replies, tracking release follow-up, collecting intake metrics, and maintaining an optional planning mirror. Project-specific behavior should be data-driven so new projects can be added without rewriting the workflow.

## Quality Principles
- Avoid duplicate issues and duplicate replies across retries.
- Preserve reporter context and link discussions to the resulting work item.
- Treat external content as untrusted input and use narrowly scoped credentials.
- Pace polling and writes to respect API limits and prevent automation loops.
- Make failures, skipped projects, unrouted posts, and operational metrics observable.
- Keep automation idempotent and safe to rerun.

## Success Criteria
- Valid reports are routed to the intended project with their context intact.
- Missing or invalid tags are handled visibly and respectfully.
- Maintainer replies and release notifications reach the right conversation.
- Scheduled runs can recover from transient failures without duplicating work.
- Operators can see project-level intake activity and diagnose failures quickly.
- Adding a project is a controlled configuration change rather than a code fork.

## Boundaries
This system automates intake and follow-up; it does not decide whether a report is valid, prioritize engineering work autonomously, or replace human support judgment. Reliability, traceability, and respectful communication matter more than maximizing polling frequency.