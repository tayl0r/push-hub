import type { FastifyReply } from 'fastify'
import { z } from 'zod'

// A schema failure's 400 body; don't swap in z.treeifyError, which returns a different shape than { formErrors, fieldErrors }.
export const invalidBody = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: 'invalid body', details: z.flattenError(error) })
