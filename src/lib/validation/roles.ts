import { z } from 'zod';

// Role input validation. `permissions` is a loose map of string→boolean at
// the boundary; the service sanitizes it against the permission catalog
// (sanitizePermissionMap drops unknown keys + false values) so an unknown
// or stale key can never be persisted as a grant.
const permissionsRecord = z.record(z.string(), z.boolean());

export const createRoleInputSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: permissionsRecord.optional(),
});

export const updateRoleInputSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: permissionsRecord.optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleInputSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleInputSchema>;
