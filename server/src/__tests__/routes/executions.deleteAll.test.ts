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
