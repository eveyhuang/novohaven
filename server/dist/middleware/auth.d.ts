import { Request, Response, NextFunction } from 'express';
export declare function authMiddleware(req: Request, res: Response, next: NextFunction): void;
export declare function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void;
export declare function requireOwnership(getResourceUserId: (req: Request) => number | null): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map