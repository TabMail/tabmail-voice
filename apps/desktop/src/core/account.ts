// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BackendError } from "./backend.js";
import * as config from "./config.js";
import type { HTTPTransport } from "./http.js";
import { log } from "./log.js";
import { Observable } from "./observable.js";
import { trimWhitespace } from "./text.js";

/** A Supabase session (same model as iOS `TabMailSession`). */
export interface TabMailSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds since 1970. */
  expiresAt: number;
  userId: string;
  userEmail: string;
}

export function expiresWithin(session: TabMailSession, seconds: number, now: number = Date.now()): boolean {
  return session.expiresAt <= Math.floor(now / 1000) + seconds;
}

/** The wire shape GoTrue returns, and the one the session is stored in. */
export function sessionFromWire(value: unknown): TabMailSession {
  if (!value || typeof value !== "object") throw new AuthError("failed", "Invalid response.");
  const wire = value as { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; user?: { id?: unknown; email?: unknown } };
  if (typeof wire.access_token !== "string" || typeof wire.refresh_token !== "string" || typeof wire.expires_at !== "number"
    || !Number.isInteger(wire.expires_at) || typeof wire.user?.id !== "string") {
    throw new AuthError("failed", "Invalid response.");
  }
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token,
    expiresAt: wire.expires_at,
    userId: wire.user.id,
    userEmail: typeof wire.user.email === "string" ? wire.user.email : "",
  };
}

export function sessionToWire(session: TabMailSession): Record<string, unknown> {
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_at: session.expiresAt,
    user: { id: session.userId, email: session.userEmail },
  };
}

export type AuthErrorKind = "emailNotRegistered" | "invalidCode" | "refreshRejected" | "failed";

export class AuthError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    /** For `failed`: what went wrong, as shown. */
    detail?: string,
  ) {
    super(
      kind === "emailNotRegistered" ? "No TabMail account uses that email. Sign up at tabmail.ai first."
        : kind === "invalidCode" ? "That code is wrong or has expired."
          : kind === "refreshRejected" ? "Your session has ended. Please sign in again."
            : (detail ?? ""),
    );
    this.name = "AuthError";
  }
}

/** Supabase GoTrue email-code sign-in and token refresh (same flow as iOS `TabMailAuthService`). */
export class AuthClient {
  constructor(
    private readonly transport: HTTPTransport,
    readonly baseURL: string = config.authBaseURL,
    readonly publishableKey: string = config.authPublishableKey,
  ) {}

  /** Emails a one-time code. Existing accounts only: sign-up happens on tabmail.ai. */
  async sendCode(email: string): Promise<void> {
    const { body, status } = await this.post("auth/v1/otp", { email, create_user: false });
    if (status !== 200) {
      const message = AuthClient.errorMessage(body) ?? `Couldn't send the code (HTTP ${status}).`;
      if (message.includes("not found") || message.includes("not allowed") || message.includes("Signups")) {
        throw new AuthError("emailNotRegistered");
      }
      throw new AuthError("failed", message);
    }
  }

  async verify(email: string, code: string): Promise<TabMailSession> {
    const { body, status } = await this.post("auth/v1/verify", { email, token: code, type: "email" });
    if (status !== 200) {
      const message = AuthClient.errorMessage(body) ?? `Verification failed (HTTP ${status}).`;
      if (message.includes("Invalid") || message.includes("expired")) throw new AuthError("invalidCode");
      throw new AuthError("failed", message);
    }
    return sessionFromWire(parse(body));
  }

  async refresh(session: TabMailSession): Promise<TabMailSession> {
    const { body, status } = await this.post("auth/v1/token?grant_type=refresh_token", { refresh_token: session.refreshToken });
    if ([400, 401, 403].includes(status)) throw new AuthError("refreshRejected");
    if (status !== 200) throw new AuthError("failed", `Couldn't refresh your session (HTTP ${status}).`);
    const refreshed = sessionFromWire(parse(body));
    if (refreshed.userId !== session.userId) throw new AuthError("refreshRejected");
    return refreshed;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ body: string; status: number }> {
    const response = await this.transport({
      method: "POST",
      url: `${this.baseURL.replace(/\/+$/, "")}/${path}`,
      timeout: config.authRequestTimeout,
      headers: {
        "Content-Type": "application/json",
        apikey: this.publishableKey,
        Authorization: `Bearer ${this.publishableKey}`,
      },
      body: JSON.stringify(body),
    });
    return { body: response.body, status: response.status };
  }

  private static errorMessage(body: string): string | undefined {
    const info = parse(body);
    if (!info || typeof info !== "object") return undefined;
    const fields = info as Record<string, unknown>;
    for (const key of ["msg", "error_description", "error"]) {
      if (typeof fields[key] === "string") return fields[key];
    }
    return undefined;
  }
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Where the signed-in session is kept. */
export interface SessionStore {
  load(): TabMailSession | null;
  save(session: TabMailSession): void;
  clear(): void;
}

/** The signed-in TabMail account and its access token. */
export class AccountModel extends Observable {
  private current: TabMailSession | null;
  /** Supabase refresh tokens are single-use: concurrent refreshes would invalidate each other, so
   * every caller awaits the one in flight. */
  private refreshing: Promise<TabMailSession> | null = null;

  constructor(
    private readonly client: AuthClient,
    private readonly store: SessionStore,
  ) {
    super();
    this.current = store.load();
  }

  get session(): TabMailSession | null {
    return this.current;
  }

  get isSignedIn(): boolean {
    return this.current !== null;
  }

  get email(): string | null {
    return this.current?.userEmail ?? null;
  }

  async sendCode(email: string): Promise<void> {
    await this.client.sendCode(trimWhitespace(email));
  }

  async verify(email: string, code: string): Promise<void> {
    const session = await this.client.verify(trimWhitespace(email), trimWhitespace(code));
    this.store.save(session);
    this.set(session);
  }

  signOut(): void {
    this.refreshing = null;
    this.store.clear();
    this.set(null);
  }

  /** A usable access token, refreshing first if it expires soon (or `forceRefresh`). Null when
   * signed out; signs out when the refresh token is rejected. */
  async validToken(forceRefresh = false): Promise<string | null> {
    if (this.refreshing) return (await this.refreshing).accessToken;
    const current = this.current;
    if (!current) return null;
    if (!forceRefresh && !expiresWithin(current, config.tokenRefreshLeewaySeconds)) return current.accessToken;

    const task = this.client.refresh(current);
    this.refreshing = task;
    try {
      const refreshed = await task;
      // Signed out while refreshing: don't resurrect the session.
      if (this.current?.userId !== current.userId) return null;
      this.store.save(refreshed);
      this.set(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      if (error instanceof AuthError && error.kind === "refreshRejected") {
        log.debug("AccountModel: refresh rejected; signing out");
        this.signOut();
      }
      throw error;
    } finally {
      if (this.refreshing === task) this.refreshing = null;
    }
  }

  private set(session: TabMailSession | null): void {
    this.current = session;
    this.changed();
  }
}

/** Runs a backend call with a valid token of the account `userId`; one retry with a forced refresh
 * if the backend says the token is no longer valid. Throws `unauthorized` when that account is no
 * longer the one signed in, so a dictation never continues under another account. */
export async function withFreshToken<T>(account: AccountModel, userId: string | null, call: (token: string) => Promise<T>): Promise<T> {
  const token = await account.validToken();
  if (token === null || (account.session?.userId ?? null) !== userId) throw new BackendError("unauthorized");
  try {
    return await call(token);
  } catch (error) {
    if (!(error instanceof BackendError) || error.kind !== "unauthorized") throw error;
    const fresh = await account.validToken(true);
    if (fresh === null || (account.session?.userId ?? null) !== userId) throw new BackendError("unauthorized");
    return await call(fresh);
  }
}

/** Which signed-in accounts may use debug mode: the same accounts as iOS `DebugModeManager`. */
export const DebugAccess = {
  /** Every account on this domain is allowed. */
  allowedEmailDomain: "tabmail.ai",
  /** Individual accounts outside `allowedEmailDomain`. Keep short: each one bypasses the domain check. */
  allowedEmails: new Set(["tabmail.ai@gmail.com"]),

  allows(email: string | null | undefined): boolean {
    if (email === null || email === undefined) return false;
    const lower = email.toLowerCase();
    return lower.endsWith(`@${DebugAccess.allowedEmailDomain}`) || DebugAccess.allowedEmails.has(lower);
  },
};
