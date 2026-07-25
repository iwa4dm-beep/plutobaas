/**
 * Small Zod validation helpers for route handlers.
 *
 * Usage:
 *   const body = parseBody(mySchema, req.body);
 *   const query = parseQuery(mySchema, req.query);
 *
 * On failure, throws a `ZodError` which the central error handler in
 * server.ts converts into a 400 JSON response with field-level messages.
 */
import { ZodError, type ZodTypeAny, type z } from 'zod';

export function parseInput<S extends ZodTypeAny>(schema: S, value: unknown, _label = 'input'): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw r.error;
  return r.data;
}

export const parseBody = <S extends ZodTypeAny>(schema: S, value: unknown) => parseInput(schema, value, 'body');
export const parseQuery = <S extends ZodTypeAny>(schema: S, value: unknown) => parseInput(schema, value, 'query');
export const parseParams = <S extends ZodTypeAny>(schema: S, value: unknown) => parseInput(schema, value, 'params');

export { ZodError };
