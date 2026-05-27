/**
 * Shape of a Convex `UserIdentity` object.
 *
 * We keep this as a plain interface rather than importing from `convex/server`
 * so that the module stays lightweight and doesn't pull in server-side types
 * at the top level.
 */
export interface UserIdentity {
  /** Stable subject identifier from the auth provider. */
  subject: string;
  /** Issuer URL for the identity token. */
  issuer: string;
  /** Stable token identifier used for local identity partitioning. */
  tokenIdentifier: string;
  /** Optional full display name. */
  name?: string;
  /** Optional email address from the auth provider. */
  email?: string;
  /** Optional avatar URL. */
  pictureUrl?: string;
  /** Optional short display name. */
  nickname?: string;
  /** Optional given/first name. */
  givenName?: string;
  /** Optional family/last name. */
  familyName?: string;
  /** Whether the provider marked the email as verified. */
  emailVerified?: boolean;
  /** Optional phone number. */
  phoneNumber?: string;
  /** Whether the provider marked the phone number as verified. */
  phoneNumberVerified?: boolean;
  /** Provider-specific last-updated timestamp string. */
  updatedAt?: string;
  /** Additional provider-specific claims copied from the identity token. */
  [key: string]: unknown;
}

/**
 * Holds the current user identity for the embedded runtime.
 *
 * Call {@link AuthResolver.setIdentity} to simulate a logged-in user; pass
 * `null` to simulate an unauthenticated state.
 *
 * @example
 * ```ts
 * const auth = createAuthResolver();
 * auth.setIdentity({
 *   subject: "user_123",
 *   issuer: "https://example.auth",
 *   tokenIdentifier: "tok_123",
 * });
 * ```
 */
export interface AuthResolver {
  /** Replace the current embedded identity. */
  setIdentity(identity: UserIdentity | null): void;
  /** Resolve the current user identity asynchronously. */
  getUserIdentity(): Promise<UserIdentity | null>;
  /** Read the current identity synchronously. */
  peekUserIdentity(): UserIdentity | null;
}

export function createAuthResolver(): AuthResolver {
  let identity: UserIdentity | null = null;
  return {
    setIdentity(next: UserIdentity | null): void {
      identity = next;
    },
    async getUserIdentity(): Promise<UserIdentity | null> {
      return identity;
    },
    peekUserIdentity(): UserIdentity | null {
      return identity;
    },
  };
}

/**
 * Derive the stable embedded identity key for persisted local data.
 *
 * The runtime prefers `tokenIdentifier` because it remains stable across
 * provider-specific token refreshes. `subject` is used as a fallback for
 * simplified test identities.
 *
 * @param identity - The current embedded identity.
 * @returns The storage partition key for that identity, or `null` when no
 * identity is active.
 */
export function getIdentityKey(
  identity: UserIdentity | null | undefined,
): string | null {
  if (!identity) {
    return null;
  }

  return identity.tokenIdentifier ?? identity.subject ?? null;
}
