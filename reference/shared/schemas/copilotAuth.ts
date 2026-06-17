// Runtime validation schemas for `/api/copilot-auth/*` routes
// (`server/routes/copilotAuth.ts`).
//
// The device/OAuth login is PTY-driven and carries no request body for
// `start`; `cancel` and `complete` are keyed on the login session id.

import { z } from 'zod';

// `POST /api/copilot-auth/cancel` — cancel an in-flight device login.
export const CancelCopilotAuthBodySchema = z
  .object({
    loginSessionId: z.string().min(1, 'loginSessionId is required'),
  })
  .strict();
export type CancelCopilotAuthBody = z.infer<typeof CancelCopilotAuthBodySchema>;

// `POST /api/copilot-auth/complete` — block until the named login finishes.
export const CompleteCopilotAuthBodySchema = z
  .object({
    loginSessionId: z.string().min(1, 'loginSessionId is required'),
  })
  .strict();
export type CompleteCopilotAuthBody = z.infer<typeof CompleteCopilotAuthBodySchema>;
