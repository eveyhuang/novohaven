# Delete All Executions Button Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Delete All" button to the Executions page that permanently deletes all of the current user's executions in one click.

**Architecture:** New `deleteAllExecutionsByUser(userId)` query added to the database queries object. A `DELETE /executions` route calls it scoped to the current user. The API client gets a `deleteAllExecutions()` method. The frontend adds `deletingAll` state and a "Delete All" danger button in the header row.

**Tech Stack:** Express (server routes), sql.js / better-sqlite3 (DB queries via `queries` object), React 18 + TypeScript (frontend), Jest + supertest (server tests)

---

### Task 1: Add `deleteAllExecutionsByUser` to database queries

**Files:**
- Modify: `server/src/models/database.ts` (around line 870 near `deleteExecution`)
- Test: `server/src/__tests__/routes/executions.deleteAll.test.ts` (created in Task 2)

**Step 1: Locate the `deleteExecution` query in `server/src/models/database.ts`**

Find around line 870:
```typescript
deleteExecution: (id: number) => {
  run('DELETE FROM step_executions WHERE execution_id = ?', [id]);
  return run('DELETE FROM workflow_executions WHERE id = ?', [id]);
},
```

**Step 2: Add `deleteAllExecutionsByUser` directly after it**

```typescript
deleteAllExecutionsByUser: (userId: number) => {
  run(
    'DELETE FROM step_executions WHERE execution_id IN (SELECT id FROM workflow_executions WHERE user_id = ?)',
    [userId]
  );
  return run('DELETE FROM workflow_executions WHERE user_id = ?', [userId]);
},
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server && npx tsc --noEmit 2>&1 | head -20
```

Expected: No new errors.

**Step 4: Commit**

```bash
git add server/src/models/database.ts
git commit -m "feat: add deleteAllExecutionsByUser query"
```

---

### Task 2: Add `DELETE /executions` backend route with test

**Files:**
- Modify: `server/src/routes/executions.ts` (before `router.delete('/:id', ...)` at line 316)
- Create: `server/src/__tests__/routes/executions.deleteAll.test.ts`

**Step 1: Write the failing test**

Create `server/src/__tests__/routes/executions.deleteAll.test.ts`:

```typescript
import request from 'supertest';
import express from 'express';

// Mock the database module — executions route uses `queries`
jest.mock('../../models/database', () => ({
  queries: {
    deleteAllExecutionsByUser: jest.fn(),
  },
}));

// Mock auth middleware — sets req.user so route can read req.user!.id
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 1 };
    next();
  },
}));

// Mock workflowEngine — executions router imports several functions from it
jest.mock('../../services/workflowEngine', () => ({
  startExecution: jest.fn(),
  approveStep: jest.fn(),
  rejectStep: jest.fn(),
  retryStep: jest.fn(),
  getExecutionStatus: jest.fn(),
}));

import { queries } from '../../models/database';
import executionsRouter from '../../routes/executions';

const mockDeleteAll = queries.deleteAllExecutionsByUser as jest.MockedFunction<
  typeof queries.deleteAllExecutionsByUser
>;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/executions', executionsRouter);
  return app;
}

describe('DELETE /executions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes all executions for the current user and returns count', async () => {
    mockDeleteAll.mockReturnValue({ changes: 5 } as any);

    const app = makeApp();
    const res = await request(app).delete('/executions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 5 });
    expect(mockDeleteAll).toHaveBeenCalledWith(1); // userId from mocked auth
  });
});
```

**Step 2: Run test to verify it FAILS**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server && npx jest --testPathPattern="executions.deleteAll" --no-coverage 2>&1
```

Expected: FAIL — route not found (404) or method `deleteAllExecutionsByUser` not called.

**Step 3: Add the route to `server/src/routes/executions.ts`**

Open `server/src/routes/executions.ts`. Find `router.delete('/:id', ...)` at line 316. Add the new bulk-delete route **directly before it**:

```typescript
// DELETE /api/executions — Delete all executions for the current user
router.delete('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = queries.deleteAllExecutionsByUser(userId);
    res.json({ success: true, deleted: result.changes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

**Step 4: Run test to verify it PASSES**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server && npx jest --testPathPattern="executions.deleteAll" --no-coverage 2>&1
```

Expected: PASS

**Step 5: Run full server test suite to check regressions**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server && npx jest --no-coverage 2>&1 | tail -10
```

Expected: New test passes; no new failures beyond the pre-existing 3 failing suites (workflowEngineDispatch, HttpExecutor, ScrapingExecutor).

**Step 6: Commit**

```bash
git add server/src/routes/executions.ts server/src/__tests__/routes/executions.deleteAll.test.ts
git commit -m "feat: add DELETE /executions bulk delete route"
```

---

### Task 3: Add `deleteAllExecutions()` to API client

**Files:**
- Modify: `client/src/services/api.ts` (after `deleteExecution` method, around line 202)

**Step 1: Find `deleteExecution` in `client/src/services/api.ts`**

Around line 202:
```typescript
async deleteExecution(id: number): Promise<{ success: boolean; message: string }> {
```

**Step 2: Add `deleteAllExecutions` immediately after it**

```typescript
async deleteAllExecutions(): Promise<{ success: boolean; deleted: number }> {
  return this.request('/executions', { method: 'DELETE' });
}
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/client && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

**Step 4: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat: add deleteAllExecutions() to API client"
```

---

### Task 4: Add "Delete All" button to Executions page

**Files:**
- Modify: `client/src/components/WorkflowExecution/ExecutionList.tsx`

**Step 1: Add `deletingAll` state**

Open `client/src/components/WorkflowExecution/ExecutionList.tsx`. Find the existing state declarations (around lines 12-17):

```typescript
const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
const [isLoading, setIsLoading] = useState(true);
const [error, setError] = useState<string | null>(null);
const [actionLoading, setActionLoading] = useState<number | null>(null);
const [confirmDelete, setConfirmDelete] = useState<WorkflowExecution | null>(null);
```

Add directly after the last `useState` line:

```typescript
const [deletingAll, setDeletingAll] = useState(false);
```

**Step 2: Add `handleDeleteAll` handler**

Find the `handleDelete` function (around line 77). Add the following immediately after its closing brace:

```typescript
const handleDeleteAll = async () => {
  if (deletingAll) return;
  setDeletingAll(true);
  try {
    await api.deleteAllExecutions();
    setExecutions([]);
  } catch (err: any) {
    setError(err.message);
  } finally {
    setDeletingAll(false);
  }
};
```

**Step 3: Add the button to the header**

Find the header section (around lines 112-122):

```tsx
<div className="flex items-center justify-between">
  <div>
    <h1 className="text-2xl font-bold text-secondary-900">Executions</h1>
    <p className="text-secondary-600 mt-1">
      View and manage your workflow executions
    </p>
  </div>
  <Button onClick={() => navigate('/')}>
    Start New Workflow
  </Button>
</div>
```

Replace with:

```tsx
<div className="flex items-center justify-between">
  <div>
    <h1 className="text-2xl font-bold text-secondary-900">Executions</h1>
    <p className="text-secondary-600 mt-1">
      View and manage your workflow executions
    </p>
  </div>
  <div className="flex items-center gap-2">
    <Button
      variant="danger"
      isLoading={deletingAll}
      disabled={deletingAll || executions.length === 0}
      onClick={handleDeleteAll}
    >
      Delete All
    </Button>
    <Button onClick={() => navigate('/')}>
      Start New Workflow
    </Button>
  </div>
</div>
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/client && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

**Step 5: Commit**

```bash
git add client/src/components/WorkflowExecution/ExecutionList.tsx
git commit -m "feat: add Delete All button to Executions page"
```

---

### Task 5: Manual smoke test

**Step 1: Start the server**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/server && npm run dev
```

**Step 2: Start the client**

```bash
cd /Users/eveyhuang/Documents/novohaven-app/client && npm start
```

**Step 3: Navigate to the Executions page**

Verify:
- "Delete All" button appears to the left of "Start New Workflow" in the header
- Button is disabled when the list is empty
- With executions present: click "Delete All", spinner appears briefly, list clears to empty state
- The per-item delete (trash icon + confirmation modal) still works independently
