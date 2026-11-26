import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { StructuredLogger } from '../logger.js';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function createErrorHandler(logger: StructuredLogger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = req.header('x-request-id') ?? res.getHeader('x-request-id');

    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.flatten(),
          requestId,
        },
      });
      return;
    }

    if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
      res.status(400).json({
        error: { code: 'INVALID_JSON', message: 'Malformed JSON request body', requestId },
      });
      return;
    }

    logger.error('Unhandled API error', {
      path: req.path,
      method: req.method,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });

    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
    });
  };
}
