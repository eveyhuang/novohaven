# Close All Sessions Button — Design

**Date:** 2026-02-19
**Status:** Approved

## Summary

Add a "Close All" button to the Session Monitor page that soft-closes all active/idle sessions in one click.

## Behavior

- Soft-close only: sets `status = 'closed'` on all non-closed sessions, preserving data in the DB.
- No confirmation dialog — closes immediately on click.
- Button shows a loading spinner while the request is in flight.
- Button is disabled when there are no non-closed sessions visible.

## Backend

**New route:** `POST /sessions/close-all` in `server/src/routes/sessions.ts`

```sql
UPDATE sessions SET status = 'closed' WHERE status != 'closed'
```

Response: `{ success: true, closed: <number of rows affected> }`

## API Client

**New method** in `client/src/services/api.ts`:

```ts
async closeAllSessions(): Promise<{ success: boolean; closed: number }> {
  return this.request('/sessions/close-all', { method: 'POST' });
}
```

## Frontend

**File:** `client/src/components/SessionMonitor/SessionMonitor.tsx`

- Add `closingAll: boolean` state (default `false`).
- Add `handleCloseAll()` async handler:
  1. Sets `closingAll = true`
  2. Calls `api.closeAllSessions()`
  3. Updates local sessions state: marks all non-closed sessions as `'closed'`
  4. Clears `expandedId`
  5. Sets `closingAll = false` in `finally`
- Add a "Close All" `<Button variant="danger" size="sm">` in the header row next to "Refresh".
  - `isLoading={closingAll}`
  - `disabled` when `closingAll` is true or no non-closed sessions exist

## Scope / Non-goals

- No i18n changes (component uses hardcoded English strings throughout).
- Does not affect already-closed sessions.
- Does not add a "delete all" or hard-delete path.
