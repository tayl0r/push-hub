import type { FastifyReply } from 'fastify'
import { z } from 'zod'

// { formErrors, fieldErrors } is the public 400 shape; don't swap in z.treeifyError, which returns a different one.
export const invalidBody = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: 'invalid body', details: z.flattenError(error) })
