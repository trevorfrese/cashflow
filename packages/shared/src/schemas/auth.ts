import { z } from 'zod';

import { Id, IsoDateTimeSchema } from './common';

export const Email = z.string().email().max(254).transform((s) => s.trim().toLowerCase());
export const Password = z.string().min(10, 'Use at least 10 characters').max(200);

export const RegisterRequest = z.object({
  email: Email,
  password: Password,
  fullName: z.string().min(1).max(120),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const RefreshRequest = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const User = z.object({
  id: Id,
  email: z.string().email(),
  fullName: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof User>;

export const AuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
});
export type AuthTokens = z.infer<typeof AuthTokens>;

export const AuthResponse = z.object({
  user: User,
  tokens: AuthTokens,
});
export type AuthResponse = z.infer<typeof AuthResponse>;
