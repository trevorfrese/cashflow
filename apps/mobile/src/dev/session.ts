import type { AuthTokens, User } from '@cashflow/shared';

/** The key `BusinessProvider` remembers the selected business under. */
export const SELECTED_BUSINESS_KEY = 'cashflow.selectedBusinessId';

export interface SessionDeps {
  /** TanStack's QueryClient, or anything with the same two methods. */
  queryClient: { cancelQueries(): Promise<void>; clear(): void };
  tokenStore: { save(tokens: AuthTokens): Promise<void> };
  storage: { remove(key: string): Promise<void> };
  setUser(user: User): void;
}

/**
 * Replace the signed in session with another one, completely.
 *
 * Order matters. In-flight requests for the old account are cancelled, the new tokens are
 * in place before anything can refetch, every cached query is dropped, and only then does
 * the app learn who the user is. So no screen can render the previous account's data under
 * the new account, and no refetch can go out with the old token.
 */
export async function replaceSession(
  next: { user: User; tokens: AuthTokens },
  deps: SessionDeps,
): Promise<void> {
  await deps.queryClient.cancelQueries();
  await deps.tokenStore.save(next.tokens);
  deps.queryClient.clear();
  await deps.storage.remove(SELECTED_BUSINESS_KEY);
  deps.setUser(next.user);
}
