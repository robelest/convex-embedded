/**
 * Simple identity injection for testing / local development.
 *
 * Allows callers to set a user identity that queries, mutations, and
 * actions can read via `ctx.auth.getUserIdentity()`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a Convex `UserIdentity` object.
 *
 * We keep this as a plain interface rather than importing from `convex/server`
 * so that the module stays lightweight and doesn't pull in server-side types
 * at the top level.
 */
export interface UserIdentity {
  subject: string;
  issuer: string;
  tokenIdentifier: string;
  name?: string;
  email?: string;
  pictureUrl?: string;
  nickname?: string;
  givenName?: string;
  familyName?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  updatedAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// AuthResolver
// ---------------------------------------------------------------------------

/**
 * Holds the current user identity for the embedded runtime.
 *
 * Call {@link setIdentity} to simulate a logged-in user; pass `null` to
 * simulate an unauthenticated state.
 */
export class AuthResolver {
  private _identity: UserIdentity | null = null;

  /**
   * Set (or clear) the current user identity.
   */
  setIdentity(identity: UserIdentity | null): void {
    this._identity = identity;
  }

  /**
   * Returns the current identity, matching the behaviour of
   * `ctx.auth.getUserIdentity()` in the Convex runtime.
   */
  async getUserIdentity(): Promise<UserIdentity | null> {
    return this._identity;
  }
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Create a {@link UserIdentity} with sensible defaults for testing.
 *
 * Only `subject` and `issuer` are strictly required by Convex; everything
 * else is filled in with reasonable placeholder values that can be
 * overridden via `attrs`.
 *
 * @example
 * ```ts
 * const identity = createTestIdentity({ name: "Alice", email: "alice@test.com" });
 * authResolver.setIdentity(identity);
 * ```
 */
export function createTestIdentity(
  attrs: Record<string, any> = {},
): UserIdentity {
  const subject = (attrs.subject as string) ?? "test-user-1";
  const issuer = (attrs.issuer as string) ?? "https://embedded.local";
  const tokenIdentifier =
    (attrs.tokenIdentifier as string) ?? `${issuer}|${subject}`;

  return {
    subject,
    issuer,
    tokenIdentifier,
    name: "Test User",
    email: "test@embedded.local",
    ...attrs,
  };
}
