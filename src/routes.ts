/**
 * HTTP route registration (Fastify).
 *
 * Routes are thin adapters: they parse and validate HTTP input, delegate to
 * the service modules, and shape responses. Business logic lives in ingest.ts,
 * resolve.ts, rebuild.ts, compare.ts, sign.ts, store.ts, and queue.ts.
 *
 * POST /submissions and the health probe are registered here; the read-only
 * verification endpoints are added in later commits.
 */

import type { FastifyInstance } from 'fastify';
import type { ServerDependencies } from './index.js';
import {
  validateAndNormalize,
  acceptSubmission,
  type SubmissionRequest,
} from './ingest.js';

/** Register every HTTP route on the provided Fastify instance. */
export function registerRoutes(app: FastifyInstance, deps: ServerDependencies): void {
  app.post<{ Body: SubmissionRequest }>('/submissions', async (request, reply) => {
    const result = validateAndNormalize(request.body);
    if (!result.ok) {
      // The rejection reasons are not persisted anywhere, so log them.
      request.log.info({ issues: result.issues }, 'rejected submission');
      return reply
        .code(400)
        .send({ error: { code: 'validation_failed', issues: result.issues } });
    }
    try {
      const accepted = await acceptSubmission(deps.database, result.value);
      return reply.code(202).send({ submissionId: accepted.submissionId });
    } catch (err) {
      // Never leak database internals to callers; log them and answer generic.
      request.log.error({ err }, 'failed to accept submission');
      return reply.code(500).send({
        error: { code: 'internal_error', message: 'could not accept submission' },
      });
    }
  });
}
