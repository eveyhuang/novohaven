# Delete All Executions Button — Design

**Date:** 2026-02-19
**Status:** Approved

## Summary

Add a "Delete All" button to the Executions page that permanently deletes all of the current user's executions in one click.

## Behavior

- Hard-delete: removes all rows from `workflow_executions` and `step_executions` for the authenticated user.
- Deletes all statuses including running/paused/pending — no filtering.
- No confirmation dialog — deletes immediately on click.
- Button shows a loading spinner while the request is in flight.
- Button is disabled when `deletingAll` is true or when there are no executions.
- On success, the execution list is cleared to `[]` locally.

## Backend

**New route:** `DELETE /executions` in `server/src/routes/executions.ts`

Must be placed **before** `DELETE /:id` to avoid Express route conflicts.

```sql
-- 1. Delete child rows scoped to user
DELETE FROM step_executions
WHERE execution_id IN (
  SELECT id FROM workflow_executions WHERE user_id = ?
);

-- 2. Delete parent rows scoped to user
DELETE FROM workflow_executions WHERE user_id = ?;
```

Response: `{ success: true, deleted: <number of workflow_executions rows deleted> }`

Uses `req.user!.id` for user scoping (consistent with the per-item delete route).

## API Client

**New method** in `client/src/services/api.ts`:

```ts
async deleteAllExecutions(): Promise<{ success: boolean; deleted: number }> {
  return this.request('/executions', { method: 'DELETE' });
}
```

## Frontend

**File:** `client/src/components/WorkflowExecution/ExecutionList.tsx`

- Add `deletingAll: boolean` state (default `false`).
- Add `handleDeleteAll()` async handler:
  1. Sets `deletingAll = true`
  2. Calls `api.deleteAllExecutions()`
  3. Sets `executions` state to `[]`
  4. Sets `deletingAll = false` in `finally`
  5. Sets `error` in `catch` (consistent with existing error handling pattern)
- Add a "Delete All" `<Button variant="danger">` in the header row, to the left of "Start New Workflow".
  - `isLoading={deletingAll}`
  - `disabled` when `deletingAll` is true or `executions.length === 0`

## Scope / Non-goals

- User-scoped: only deletes the current user's executions.
- No i18n changes (component uses a mix of `t()` and hardcoded strings — "Delete All" follows the existing hardcoded pattern).
- Does not cancel running executions before deleting — just removes DB rows.
