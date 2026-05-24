import {
  AuthResolver,
  getIdentityKey,
  type UserIdentity,
} from "@embedded/auth";
import { createTestIdentity } from "@embedded/test";
import { describe, expect, it } from "@tests/testkit";

describe("AuthResolver", () => {
  it("returns null before any identity is set", async () => {
    const auth = new AuthResolver();

    await expect(auth.getUserIdentity()).resolves.toBeNull();
  });

  it("returns the identity passed to setIdentity", async () => {
    const auth = new AuthResolver();
    const identity = createTestIdentity();
    auth.setIdentity(identity);

    await expect(auth.getUserIdentity()).resolves.toBe(identity);
  });

  it("clears the identity when set to null", async () => {
    const auth = new AuthResolver();
    auth.setIdentity(createTestIdentity());
    auth.setIdentity(null);

    await expect(auth.getUserIdentity()).resolves.toBeNull();
  });

  it("exposes the current identity synchronously via peekUserIdentity", () => {
    const auth = new AuthResolver();
    const identity = createTestIdentity();
    auth.setIdentity(identity);

    expect(auth.peekUserIdentity()).toBe(identity);
  });
});

describe("createTestIdentity", () => {
  it("populates subject, issuer, tokenIdentifier, name and email by default", () => {
    const identity = createTestIdentity();

    expect(identity).toMatchObject({
      subject: "test-user-1",
      issuer: "https://embedded.local",
      tokenIdentifier: "https://embedded.local|test-user-1",
      name: "Test User",
      email: "test@embedded.local",
    });
  });

  it("lets overrides replace the default subject, name and email", () => {
    const identity = createTestIdentity({
      subject: "alice",
      name: "Alice",
      email: "alice@test.com",
    });

    expect(identity).toMatchObject({
      subject: "alice",
      name: "Alice",
      email: "alice@test.com",
    });
  });

  it("derives tokenIdentifier from issuer|subject", () => {
    const identity = createTestIdentity({
      subject: "bob",
      issuer: "https://custom.issuer",
    });

    expect(identity.tokenIdentifier).toBe("https://custom.issuer|bob");
  });

  it("keeps an explicitly provided tokenIdentifier", () => {
    const identity = createTestIdentity({
      tokenIdentifier: "custom-token-id",
    });

    expect(identity.tokenIdentifier).toBe("custom-token-id");
  });

  it("spreads extra attributes onto the result", () => {
    const identity = createTestIdentity({
      pictureUrl: "https://example.com/pic.jpg",
      nickname: "tester",
      customField: 42,
    });

    expect(identity.pictureUrl).toBe("https://example.com/pic.jpg");
    expect(identity.nickname).toBe("tester");
    expect(identity.customField).toBe(42);
  });
});

describe("getIdentityKey", () => {
  it("prefers tokenIdentifier over subject", () => {
    const key = getIdentityKey(
      createTestIdentity({ tokenIdentifier: "issuer|alice", subject: "alice" }),
    );

    expect(key).toBe("issuer|alice");
  });

  it("falls back to subject when tokenIdentifier is missing", () => {
    const identity = {
      subject: "alice",
      issuer: "issuer",
    } as unknown as UserIdentity;

    expect(getIdentityKey(identity)).toBe("alice");
  });

  it("returns null for a null identity", () => {
    expect(getIdentityKey(null)).toBeNull();
  });
});
