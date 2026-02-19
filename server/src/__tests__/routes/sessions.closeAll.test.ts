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
