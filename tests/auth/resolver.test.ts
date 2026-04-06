import {
  AuthResolver,
  createTestIdentity,
  getIdentityKey,
} from "@embedded/auth/resolver";
import { describe, it, expect } from "vite-plus/test";

describe("AuthResolver", () => {
  it("initial state: getUserIdentity returns null", async () => {
    const auth = new AuthResolver();

    const identity = await auth.getUserIdentity();

    expect(identity).toBeNull();
  });

  it("setIdentity: getUserIdentity returns the set identity", async () => {
    const auth = new AuthResolver();
    const identity = createTestIdentity();
    auth.setIdentity(identity);

    const result = await auth.getUserIdentity();

    expect(result).toBe(identity);
  });

  it("setIdentity(null): clears the identity", async () => {
    const auth = new AuthResolver();
    auth.setIdentity(createTestIdentity());
    auth.setIdentity(null);

    const result = await auth.getUserIdentity();

    expect(result).toBeNull();
  });
});

describe("createTestIdentity", () => {
  it("defaults: has subject, issuer, tokenIdentifier, name, email", () => {
    const identity = createTestIdentity();

    expect(identity.subject).toBe("test-user-1");
    expect(identity.issuer).toBe("https://embedded.local");
    expect(identity.tokenIdentifier).toBe("https://embedded.local|test-user-1");
    expect(identity.name).toBe("Test User");
    expect(identity.email).toBe("test@embedded.local");
  });

  it("with overrides: custom subject, name, email override defaults", () => {
    const identity = createTestIdentity({
      subject: "alice",
      name: "Alice",
      email: "alice@test.com",
    });

    expect(identity.subject).toBe("alice");
    expect(identity.name).toBe("Alice");
    expect(identity.email).toBe("alice@test.com");
  });

  it("tokenIdentifier: auto-generated from issuer|subject", () => {
    const identity = createTestIdentity({
      subject: "bob",
      issuer: "https://custom.issuer",
    });

    expect(identity.tokenIdentifier).toBe("https://custom.issuer|bob");
  });

  it("custom tokenIdentifier: uses provided value", () => {
    const identity = createTestIdentity({
      tokenIdentifier: "custom-token-id",
    });

    expect(identity.tokenIdentifier).toBe("custom-token-id");
  });

  it("extra fields: additional attrs are spread into result", () => {
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
  it("prefers tokenIdentifier", () => {
    expect(
      getIdentityKey(
        createTestIdentity({
          tokenIdentifier: "issuer|alice",
          subject: "alice",
        }),
      ),
    ).toBe("issuer|alice");
  });

  it("falls back to subject when tokenIdentifier is missing", () => {
    expect(getIdentityKey({ subject: "alice", issuer: "issuer" } as any)).toBe(
      "alice",
    );
  });

  it("returns null for null identity", () => {
    expect(getIdentityKey(null)).toBeNull();
  });
});
