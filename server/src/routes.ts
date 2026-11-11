// The /api routes outside the fleet API: a liveness probe, and a JSON 404 for every other /api path, so a mistyped API call is
// never answered with the single-page app that index.ts serves for the remaining paths.
import { Router, type Request, type Response } from 'express';

const health = (_req: Request, res: Response): void => void res.json({ status: 'ok' });
const unknownApi = (_req: Request, res: Response): void => void res.status(404).json({ error: 'Not found' });

export function createRouter(): Router {
  return Router().get('/api/health', health).use('/api', unknownApi);
}
