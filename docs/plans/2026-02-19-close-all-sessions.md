# Close All Sessions Button Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Close All" button to the Session Monitor page that soft-closes all active/idle sessions in one click.

**Architecture:** New `POST /sessions/close-all` backend route runs a single SQL `UPDATE` to mark all non-closed sessions as `'closed'`. The API client gets a `closeAllSessions()` method. The frontend adds a `closingAll` state and a "Close All" danger button next to the existing "Refresh" button.

**Tech Stack:** Express (server routes), better-sqlite3 (DB queries), React 18 + TypeScript (frontend), Jest (server tests)

---

### Task 1: Add `POST /sessions/close-all` backend route

**Files:**
- Modify: `server/src/routes/sessions.ts`
- Create: `server/src/__tests__/routes/sessions.closeAll.test.ts`

**Step 1: Write the failing test**

Create `server/src/__tests__/routes/sessions.closeAll.test.ts`:

```typescript
import request from 'supertest';
import express from 'express';

// Mock the database module
jest.mock('../../models/database', () => ({
  getDatabase: jest.fn(),
}));

// Mock auth middleware to pass through
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import { getDatabase } from '../../models/database';
import sessionsRouter from '../../routes/sessions';

const mockGetDatabase = getDatabase as jest.MockedFunction<typeof getDatabase>;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/sessions', sessionsRouter);
  return app;
}

describe('POST /sessions/close-all', () => {
  it('closes all non-closed sessions and returns count', async () => {
    const mockRun = jest.fn().mockReturnValue({ changes: 3 });
    const mockPrepare = jest.fn().mockReturnValue({ run: mockRun });
    mockGetDatabase.mockReturnValue({ prepare: mockPrepare } as any);

    const app = makeApp();
    const res = await request(app).post('/sessions/close-all');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, closed: 3 });
    expect(mockPrepare).toHaveBeenCalledWith(
      "UPDATE sessions SET status = 'closed' WHERE status != 'closed'"
    );
  });
});
```

**Step 2: Check that `supertest` is available**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server
npx jest --testPathPattern="sessions.closeAll" 2>&1 | head -20
```

If supertest is missing, install it:
```bash
cd /Users/eveyhuang/Documents/novohaven-app/server
npm install --save-dev supertest @types/supertest
```

**Step 3: Run test to verify it fails**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server
npx jest --testPathPattern="sessions.closeAll" --no-coverage
```

Expected: FAIL — "Cannot find module '../../routes/sessions'" or route not found (404).

**Step 4: Add the route to `server/src/routes/sessions.ts`**

Open `server/src/routes/sessions.ts`. After the existing `router.post('/:id/close', ...)` handler (around line 62), add the new route **before** it (order matters — `/close-all` must come before `/:id/close` to avoid Express treating "close-all" as an `:id`):

Add this block after line 61 (`router.use(authMiddleware);`) but **before** the existing `router.delete('/:id', ...)` block — actually, add it anywhere but ensure it is listed before any `/:id` routes. The safest spot is right after the `router.get('/', ...)` handler (after line 22):

```typescript
// Close all non-closed sessions
router.post('/close-all', (req, res) => {
  const db = getDatabase();
  const result = db.prepare(
    "UPDATE sessions SET status = 'closed' WHERE status != 'closed'"
  ).run();
  res.json({ success: true, closed: result.changes });
});
```

Place it **before** `router.get('/:id', ...)` on line 25.

**Step 5: Run test to verify it passes**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server
npx jest --testPathPattern="sessions.closeAll" --no-coverage
```

Expected: PASS

**Step 6: Run all server tests to check for regressions**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server
npx jest --no-coverage
```

Expected: All existing tests still PASS.

**Step 7: Commit**

```bash
git add server/src/routes/sessions.ts server/src/__tests__/routes/sessions.closeAll.test.ts
git commit -m "feat: add POST /sessions/close-all route"
```

---

### Task 2: Add `closeAllSessions()` to API client

**Files:**
- Modify: `client/src/services/api.ts:464-466` (after the existing `deleteAllSessions` method)

**Step 1: Add the method**

Open `client/src/services/api.ts`. Find the `deleteAllSessions` method (around line 464). Add the new method immediately after it:

```typescript
async closeAllSessions(): Promise<{ success: boolean; closed: number }> {
  return this.request('/sessions/close-all', { method: 'POST' });
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/client
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

**Step 3: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat: add closeAllSessions() to API client"
```

---

### Task 3: Add "Close All" button to Session Monitor

**Files:**
- Modify: `client/src/components/SessionMonitor/SessionMonitor.tsx`

**Step 1: Add `closingAll` state**

Open `client/src/components/SessionMonitor/SessionMonitor.tsx`. Find the existing state declarations (around line 124-128):

```typescript
const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
```

Add directly after that line:

```typescript
const [closingAll, setClosingAll] = useState(false);
```

**Step 2: Add `handleCloseAll` handler**

Find the `handleClose` function (around line 148). Add the following async handler directly after the `handleClose` closing brace:

```typescript
const handleCloseAll = async () => {
  if (closingAll) return;
  setClosingAll(true);
  try {
    await api.closeAllSessions();
    setSessions((prev) =>
      prev.map((s) => (s.status !== 'closed' ? { ...s, status: 'closed' } : s))
    );
    setExpandedId(null);
  } catch (err: any) {
    console.error('Failed to close all sessions:', err);
  } finally {
    setClosingAll(false);
  }
};
```

**Step 3: Add the button to the header row**

Find the header row (around line 199-203):

```tsx
<div className="flex items-center justify-between">
  <h2 className="text-xl font-semibold text-secondary-800">Session Monitor</h2>
  <Button variant="secondary" size="sm" onClick={fetchSessions}>
    Refresh
  </Button>
</div>
```

Replace it with:

```tsx
<div className="flex items-center justify-between">
  <h2 className="text-xl font-semibold text-secondary-800">Session Monitor</h2>
  <div className="flex items-center gap-2">
    <Button
      variant="danger"
      size="sm"
      isLoading={closingAll}
      disabled={closingAll || sessions.every((s) => s.status === 'closed')}
      onClick={handleCloseAll}
    >
      Close All
    </Button>
    <Button variant="secondary" size="sm" onClick={fetchSessions}>
      Refresh
    </Button>
  </div>
</div>
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/client
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

**Step 5: Commit**

```bash
git add client/src/components/SessionMonitor/SessionMonitor.tsx
git commit -m "feat: add Close All button to Session Monitor"
```

---

### Task 4: Manual smoke test

**Step 1: Start the server**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server
npm run dev
```

**Step 2: Start the client**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/client
npm start
```

**Step 3: Navigate to Session Monitor**

Open the app in the browser and navigate to the Session Monitor page.

Verify:
- "Close All" button is visible next to "Refresh" in the header
- If there are active/idle sessions: click "Close All", button shows spinner briefly, all sessions disappear from the list
- If all sessions are already closed: "Close All" button is disabled
- The per-row "Close" buttons still work independently
