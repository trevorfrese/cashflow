import { z } from 'zod';

export const Id = z.string().min(1);
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const Cents = z.number().int().nonnegative();
export const Bps = z.number().int().min(0).max(10_000);
export const DueDayOfMonth = z.number().int().min(1).max(31);
export const PeriodMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM');

export const Address = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(2),
  postalCode: z.string().min(3).max(12),
});
export type Address = z.infer<typeof Address>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
