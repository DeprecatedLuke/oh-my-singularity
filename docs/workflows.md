# OMS Workflow System

## Overview

OMS provides a flexible workflow system with two modes that give you complete control over how tasks are processed and how side effects (changes) are handled:

- **Autonomous Mode (Default)**: Tasks process automatically without human approval. Side effects execute immediately. No configuration needed — this is the default behavior.
- **PM Mode (Interactive Workflow)**: Requires explicit human approval for task state changes. Side effects are queued for review before execution. Ideal for high-assurance workflows where you want oversight of critical decisions.

This document explains how to use both modes and configure your preferred workflow.

## Default Autonomous Mode

### Current Behavior

By default, OMS operates in **autonomous mode**. This is the standard behavior you get without any configuration:

1. Singularity receives a task request
2. Issuer explores the codebase and decides whether to proceed
3. Worker implements the task and generates side effects (comments, status updates, spawned tasks)
4. **Side effects execute immediately** — no review or approval needed
5. Finisher handles cleanup and closes the task
6. Pipeline repeats for the next task

### Why Autonomous Mode

Autonomous mode is optimized for:
- **Speed**: Tasks flow through the pipeline without waiting for approval
- **Minimal Configuration**: Works exactly as is — no setup required
- **Routine Tasks**: Well-understood, lower-risk work like bug fixes and feature implementation
- **CI/CD Integration**: Ideal for automated pipelines where human oversight isn't needed

### No Action Required

Autonomous mode is the default. Existing users don't need to make any changes — your system will continue to work exactly as before.

```json
// This is the default behavior — you don't need to add this to config
{
  "autoProcessReadyTasks": true
}
```

## PM Mode (Interactive Workflow)

### What Is PM Mode?

**PM Mode** (Project Manager Mode) is an interactive workflow where you explicitly approve all task state changes before they're applied. Instead of side effects executing immediately, they're **queued for manual review**. You examine the proposed changes and decide:

- **Approve** → Side effects execute immediately
- **Reject** → Side effects are discarded, worker output is rolled back

This gives you human oversight over critical decisions while letting workers execute their tasks normally.

### When to Use PM Mode

Use PM Mode when you need:

- **Human Oversight**: Critical tasks where you want to review changes before they commit
- **Learning Scenarios**: Exploring how OMS handles complex problems
- **High Assurance Workflows**: Systems where incorrect state changes have significant impact
- **Architectural Decisions**: Changes that affect system design or dependencies
- **Quality Gates**: Ensuring changes meet project standards before committing

### How Side Effect Approval Works

The PM mode workflow is straightforward:

1. You configure PM mode by setting `autoProcessReadyTasks: false`
2. Singularity loads the PM mode prompt and spawns
3. Singularity dispatches a worker to handle a task
4. Worker executes normally and generates side effects (comments, status updates, spawned agents)
5. **Side effects are queued** — not executed yet
6. Singularity calls `get_pending_side_effects(taskId)` to see what changes are proposed
7. You review the side effects and decide:
   - Good outcome? Call `approve_side_effects(taskId)` → side effects execute
   - Bad outcome? Call `reject_side_effects(taskId)` → side effects are discarded
8. Pipeline continues to the next task

### Singularity's Orchestration Role

In PM mode, **Singularity acts as the orchestrator and decision-maker**:

- Singularity loads the PM mode prompt (singularity-pm.md)
- Singularity uses `replace_agent` to dispatch workers to specific tasks
- Singularity calls PM mode tools to manage side effects:
  - `get_pending_side_effects(taskId)` — review proposed changes
  - `approve_side_effects(taskId)` — apply approved changes
  - `reject_side_effects(taskId)` — discard unwanted changes
- Singularity decides which tasks to work on and in what order
- You (via the TUI) can influence Singularity's decisions through commentary and feedback

## Configuration Guide

### Configuration File Locations

OMS supports configuration through multiple sources (in order of precedence):

1. **Environment Variables** — highest precedence, overrides everything
2. **Local Project Config** — `.oms/config.json` in your project directory
3. **Global User Config** — `~/.oms/config.json` in your home directory
4. **Defaults** — built-in defaults (autonomous mode, 5 workers, 15-minute steering)

### The autoProcessReadyTasks Flag

The `autoProcessReadyTasks` flag controls which workflow mode is active:

```json
{
  "autoProcessReadyTasks": true   // Autonomous mode (default)
}
```

or

```json
{
  "autoProcessReadyTasks": false  // PM mode (interactive)
}
```

**Defaults to `true`** (autonomous mode) if not specified. You only need to add this to your config if you want to enable PM mode.

### Engine Selection Logic

OMS automatically selects the appropriate workflow engine based on your config:

- **`autoProcessReadyTasks: true` or omitted** → `AutonomousWorkflowEngine`
  - Side effects execute immediately
  - Tasks flow automatically through the pipeline
  - No review or approval needed

- **`autoProcessReadyTasks: false`** → `InteractiveWorkflowEngine`
  - Side effects are queued for manual review
  - Singularity calls `get_pending_side_effects` to review changes
  - Singularity approves/rejects before effects execute

### Environment Variable Override

You can override the config file by setting an environment variable:

```bash
export OMS_WORKFLOW_AUTO_PROCESS=false
oms
```

The environment variable takes precedence over config files:

- `OMS_WORKFLOW_AUTO_PROCESS=true` → Autonomous mode
- `OMS_WORKFLOW_AUTO_PROCESS=false` → PM mode
- `OMS_WORKFLOW_AUTO_PROCESS=1` → Autonomous mode (1 = true)
- `OMS_WORKFLOW_AUTO_PROCESS=0` → PM mode (0 = false)

## Configuration Examples

### Example 1: Enable PM Mode

**File:** `.oms/config.json` (in your project directory)

```json
{
  "autoProcessReadyTasks": false
}
```

**Effect:**
- Singularity loads the PM mode prompt (`singularity-pm.md`)
- `InteractiveWorkflowEngine` is used to manage task dispatch
- Side effects are queued instead of executed immediately
- Singularity reviews and approves/rejects side effects before they commit
- You see the PM mode workflow in the TUI

### Example 2: Explicit Autonomous Mode

**File:** `.oms/config.json` (in your project directory)

```json
{
  "autoProcessReadyTasks": true
}
```

**Effect:**
- Same as default behavior — no config needed
- `AutonomousWorkflowEngine` is used
- Side effects execute immediately
- Tasks flow automatically through the pipeline

### Example 3: PM Mode via Environment Variable

**Command:**

```bash
export OMS_WORKFLOW_AUTO_PROCESS=false
oms
```

**Effect:**
- Environment variable overrides config file
- PM mode is enabled even if config says autonomous
- Singularity loads PM mode prompt
- Side effects are queued for manual review

### Example 4: Global User Configuration

**File:** `~/.oms/config.json` (in your home directory)

```json
{
  "autoProcessReadyTasks": false,
  "steering": {
    "interval": 900000
  }
}
```

**Effect:**
- PM mode is enabled globally for all projects
- All OMS invocations use interactive workflow
- Can be overridden per-project with `.oms/config.json`

## PM Mode Step-by-Step Workflow

Here's a complete walkthrough of PM mode in action:

### Step 1: Configure OMS for PM Mode

```bash
# Create local project config
mkdir -p .oms
cat > .oms/config.json << 'EOF'
{
  "autoProcessReadyTasks": false
}
EOF
```

### Step 2: Start OMS

```bash
oms
```

**What happens:**
- OMS reads config and detects `autoProcessReadyTasks: false`
- OMS selects `InteractiveWorkflowEngine`
- Singularity spawns with the PM mode prompt loaded
- TUI displays the PM mode workflow interface

### Step 3: Singularity Receives a Task

```
Singularity (PM Mode): Ready to process tasks
Task received: "task-123" - Implement authentication feature
Status: ready (awaiting dispatch)
```

### Step 4: Singularity Dispatches a Worker

Singularity analyzes the task and decides to dispatch a worker:

```
Singularity (PM Mode): Dispatching worker...
[Tool] replace_agent("worker", "task-123")
Worker: Starting implementation of task-123
```

### Step 5: Worker Executes Normally

The worker does its normal job — code analysis, implementation, testing, etc. The worker generates side effects:

```
Worker: Implementing authentication feature...
  - Adding OAuth provider support
  - Writing tests
  - Updating documentation
Worker: Completed task-123

Side effects generated (queued, not executed):
  - PostComment: "Added OAuth2 support with PKCE flow"
  - UpdateTaskStatus: "ready" → "in_progress"
  - SpawnFollowUp: Security review task
```

### Step 6: Singularity Reviews Side Effects

Singularity calls the PM mode tool to see what side effects are queued:

```
Singularity (PM Mode): [Tool] get_pending_side_effects("task-123")

Response:
{
  "taskId": "task-123",
  "effectCount": 3,
  "effects": [
    {
      "type": "post_comment",
      "summary": "Comment: 'Added OAuth2 support with PKCE flow'"
    },
    {
      "type": "update_task_status",
      "summary": "Update task status from ready to in_progress"
    },
    {
      "type": "spawn_followup",
      "summary": "Spawn security-review task"
    }
  ]
}
```

### Step 7: Singularity Reviews and Decides

Singularity examines each side effect:

✅ Comment is accurate — describes the implementation correctly
✅ Status update is appropriate — moving from ready to in_progress
✅ Spawned task is relevant — security review is necessary for OAuth

**Decision: Approve**

### Step 8: Singularity Approves Side Effects

```
Singularity (PM Mode): Approving side effects...
[Tool] approve_side_effects("task-123")

Response:
{
  "approved": true,
  "taskId": "task-123"
}

Result:
✓ Comment posted to task
✓ Task status updated to in_progress
✓ Security review task spawned
```

### Step 9: Pipeline Continues

```
Singularity (PM Mode): Side effects applied successfully
Ready for next task...

Task received: "task-456" - Fix database timeout
Status: ready (awaiting dispatch)
[Cycle repeats]
```

## PM Mode Tools Reference

### get_pending_side_effects(taskId)

Retrieve a list of all side effects queued for a task, waiting for your approval or rejection.

**Purpose:** Review what changes a worker proposed before committing them.

**Input:**

```json
{
  "taskId": "task-abc123"
}
```

**Output:**

```json
{
  "taskId": "task-abc123",
  "effectCount": 3,
  "effects": [
    {
      "type": "post_comment",
      "summary": "Comment: 'Implementation completed successfully'"
    },
    {
      "type": "update_task_status",
      "summary": "Update task status to done"
    },
    {
      "type": "spawn_followup",
      "summary": "Spawn deployment task"
    }
  ]
}
```

**When to use:**
- After a worker completes to see what changes it proposed
- When unsure about worker output — review before approving
- To understand what state changes will occur

### approve_side_effects(taskId)

Apply all queued side effects for a task. This executes the changes and moves the task forward.

**Purpose:** Approve the worker's output and commit all proposed changes.

**Input:**

```json
{
  "taskId": "task-abc123"
}
```

**Output:**

```json
{
  "approved": true,
  "taskId": "task-abc123"
}
```

**Effects execute in order:**
1. All comments are posted to the task
2. Task status is updated
3. New follow-up tasks are spawned and queued

**When to use:**
- When you've reviewed side effects and they look good
- To move the task forward to the next stage
- When worker output aligns with task goals

### reject_side_effects(taskId)

Discard all queued side effects for a task without executing them. The task remains in its current state.

**Purpose:** Discard worker output and ask the worker to retry with corrections.

**Input:**

```json
{
  "taskId": "task-abc123"
}
```

**Output:**

```json
{
  "rejected": true,
  "taskId": "task-abc123"
}
```

**Effect:**
- All queued side effects are deleted and discarded
- Task remains in its current state (no changes applied)
- Worker can be dispatched again with clarifications or corrections

**When to use:**
- When side effects are incorrect or out of scope
- When worker output contradicts task requirements
- When you want the worker to retry with a different approach

## Side Effects Explained

### What Are Side Effects?

Side effects are the **changes** that worker agents produce. They represent state transitions in the task management system:

- **PostComment** — Adding a comment to a task (explanation, notes, feedback)
- **UpdateTaskStatus** — Changing a task's status (ready → in_progress → done, or ready → blocked)
- **SpawnFollowUp** — Creating and queuing a new follow-up task for the next phase of work

### Why Approve/Reject Side Effects?

In autonomous mode, side effects execute immediately — the system trusts the worker to do the right thing. In PM mode, side effects are held for your review because:

1. **Review before commitment** — You can examine proposed changes before they affect task state
2. **Prevent mistakes** — If a worker made an error or went off-track, you can reject the changes instead of committing them
3. **Quality gate** — Ensures all state transitions align with your project's goals and conventions
4. **Learning and debugging** — Understand what decisions workers make and why

### Typical Side Effect Patterns

**Pattern 1: Successful Implementation**

```
PostComment: "Implementation complete. Added feature X, tests passing."
UpdateTaskStatus: "ready" → "in_progress"
SpawnFollowUp: "design-review" task
```

**Pattern 2: Issue Found**

```
PostComment: "Found security issue in authentication flow. Reverted changes."
UpdateTaskStatus: "ready" → "blocked"
SpawnFollowUp: "security-audit" task
```

**Pattern 3: Refinement Needed**

```
PostComment: "Implementation working but needs edge case handling"
UpdateTaskStatus: "ready" → "in_progress"
SpawnFollowUp: "edge-case-testing" task
```

## Troubleshooting

### PM Mode Not Activating

**Symptom:** You set `autoProcessReadyTasks: false` but PM mode doesn't start.

**Diagnosis:**
- Check config file location: OMS reads from `.oms/config.json` (project) then `~/.oms/config.json` (home)
- Verify JSON syntax is valid (no trailing commas, properly quoted keys)
- Check environment variable precedence: `OMS_WORKFLOW_AUTO_PROCESS` overrides config files
- Verify config actually contains the flag: `autoProcessReadyTasks: false`

**Solution:**
```bash
# Verify config file exists and has correct content
cat .oms/config.json

# Check environment variables
echo $OMS_WORKFLOW_AUTO_PROCESS

# Try explicit env var override
export OMS_WORKFLOW_AUTO_PROCESS=false
oms
```

### Side Effects Not Queuing

**Symptom:** PM mode is active but `get_pending_side_effects` returns empty list.

**Diagnosis:**
- Worker didn't produce any output (check worker logs)
- Side effects were already approved/rejected
- Task ID is incorrect
- InteractiveWorkflowEngine isn't loaded (verify `autoProcessReadyTasks: false`)

**Solution:**
```bash
# Verify correct engine is loaded (check logs)
# Verify task ID matches the task you're working on
# Re-dispatch worker to generate new side effects
# Check system logs for error messages
```

### Wrong Prompt Loaded

**Symptom:** Singularity loads the default prompt instead of PM mode prompt.

**Diagnosis:**
- Config not being read correctly
- Environment variable not set
- Prompt file path incorrect

**Solution:**
```bash
# Verify PM mode is configured
grep autoProcessReadyTasks .oms/config.json

# Check logs for engine selection message
# Verify singularity-pm.md exists in src/agents/prompts/
```

### Approval Failed

**Symptom:** `approve_side_effects` returns an error.

**Diagnosis:**
- Task already approved or rejected
- Database connection issue
- Workflow engine not initialized properly

**Solution:**
- Check system logs for detailed error message
- Retry the approval
- Restart OMS if connection issue suspected
- Manually investigate task state if problem persists

### Rejection Failed

**Symptom:** `reject_side_effects` returns an error.

**Diagnosis:**
- Task already approved (can't reject approved effects)
- System error in cleanup
- Extension system unavailable

**Solution:**
- Check logs for error details
- Note the issue and escalate if needed
- Restart OMS and try again

## Migration Guide

### For Existing Users

**No migration needed.** The default behavior is unchanged:

- Autonomous mode is the default
- `autoProcessReadyTasks` defaults to `true`
- OMS works exactly as before without any configuration
- Existing workflows, scripts, and automation continue to work

### To Try PM Mode

If you want to experiment with PM mode:

1. **Add config file:**

   ```bash
   mkdir -p .oms
   cat > .oms/config.json << 'EOF'
   {
     "autoProcessReadyTasks": false
   }
   EOF
   ```

2. **Start OMS with PM mode:**

   ```bash
   oms
   ```

3. **Observe PM mode workflow:**
   - Singularity loads PM prompt
   - You review and approve/reject side effects
   - Tasks flow through pipeline with your approval

### To Revert to Autonomous Mode

1. **Remove config flag:**

   ```bash
   rm .oms/config.json
   ```

   Or set to `true`:

   ```json
   {
     "autoProcessReadyTasks": true
   }
   ```

2. **Unset environment variable (if set):**

   ```bash
   unset OMS_WORKFLOW_AUTO_PROCESS
   ```

3. **Restart OMS:**

   ```bash
   oms
   ```

## Architecture Reference

### Workflow Engines

OMS uses a pluggable workflow engine system:

- **WorkflowEngine** — Base class with common dispatch logic and side effect handling
- **AutonomousWorkflowEngine** — Executes side effects immediately (default)
- **InteractiveWorkflowEngine** — Queues side effects for manual approval (PM mode)

### Configuration System

Configuration flows through multiple layers:

1. Defaults (autonomous mode, 5 workers, 15-min steering)
2. Global config (`~/.oms/config.json`)
3. Project config (`.oms/config.json`)
4. Environment variables (highest precedence)

### Singularity PM Prompt

In PM mode, Singularity uses the PM prompt (`src/agents/prompts/singularity-pm.md`) which:

- Explains PM mode principles and workflow
- Provides detailed tool documentation
- Includes approval/rejection criteria
- Shows example workflows and troubleshooting

### Side Effect Queue

The `InteractiveWorkflowEngine` maintains a side effect queue:

- Effects are added when a dispatch completes
- Effects remain queued until approved or rejected
- Approval executes all queued effects in order
- Rejection discards all queued effects

## Best Practices

### Autonomous Mode

Use autonomous mode for:
- Routine, well-understood tasks
- High-volume work where speed matters
- CI/CD pipelines and automation
- Tasks where you trust the worker's judgment

### PM Mode

Use PM mode for:
- Critical decisions affecting architecture or stability
- Learning scenarios where you want oversight
- High-assurance workflows requiring human sign-off
- Complex tasks with uncertain outcomes

### General Recommendations

1. **Start with autonomous mode** — Use the default unless you have a specific reason for PM mode
2. **Use PM mode selectively** — Enable it for critical projects or learning, not all tasks
3. **Document your workflow** — Make it clear to your team which mode you're using and why
4. **Monitor patterns** — Track which side effects get rejected and why; adjust worker prompts accordingly
5. **Combine with steering** — Use steering agents alongside PM mode for additional oversight

## Further Reading

For more information about OMS:

- [README.md](../README.md) — System overview and architecture
- [Agent Roles](../README.md#agent-roles) — Description of each agent type
- [Pipeline Flow](../README.md#pipeline-flow) — How tasks move through the system
