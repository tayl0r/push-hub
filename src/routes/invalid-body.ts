import type { FastifyReply } from 'fastify'
import { z } from 'zod'

// Every route's 400 for a body that fails its schema. The { formErrors, fieldErrors } shape is the API;
// z.treeifyError (which .flatten()'s deprecation note pointed to) returns another shape.
export const invalidBody = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: 'invalid body', details: z.flattenError(error) })
