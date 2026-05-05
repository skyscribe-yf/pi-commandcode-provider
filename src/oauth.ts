/**
 * Command Code OAuth provider for pi's /login flow.
 *
 * Implements a browser-assisted API key retrieval flow:
 * 1. Starts a local HTTP server on a random port
 * 2. Opens the Command Code Studio auth page in the browser
 * 3. The user authenticates on the Command Code website
 * 4. The website POSTs the API key back to the local server
 * 5. The API key is stored in pi's auth.json as OAuth credentials
 *
 * Since Command Code API keys don't expire, we store them as
 * OAuth credentials with a far-future expiry.
 */

import { randomBytes } from "node:crypto"
import { startAuthServer } from "./auth-server.ts"

const STUDIO_BASE_URL = "https://commandcode.ai"
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000 // API keys don't expire

export interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void
  onPrompt(params: { message: string }): Promise<string>
}

export interface OAuthCredentials {
  refresh: string
  access: string
  expires: number
}

function generateStateToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Starts the browser-based login flow for Command Code.
 *
 * Returns OAuth credentials where access == refresh == the user's API key.
 * The keys don't expire, so we set a far-future expiry.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const authServer = await startAuthServer()
  const stateToken = generateStateToken()

  const authUrl = `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(`http://localhost:${authServer.port}/callback`)}&state=${encodeURIComponent(stateToken)}`

  // Tell pi to open the browser
  callbacks.onAuth({ url: authUrl })

  // Wait for the Command Code Studio to POST the API key back
  let callback: { apiKey: string; state: string }
  try {
    callback = await authServer.waitForCallback
  } catch (error) {
    // Clean up server on error
    authServer.server.close()
    throw error
  }

  // Validate state token to prevent CSRF
  if (callback.state !== stateToken) {
    authServer.server.close()
    throw new Error("State token mismatch. Authentication may have been tampered with.")
  }

  // Return as OAuth credentials. Since CC API keys don't expire,
  // we set a far-future expiry and use the API key as both access and refresh.
  return {
    refresh: callback.apiKey,
    access: callback.apiKey,
    expires: Date.now() + TEN_YEARS_MS,
  }
}

/**
 * Command Code API keys don't expire, so "refresh" is a no-op.
 * Returns the same credentials with an updated far-future expiry.
 */
export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return {
    refresh: credentials.refresh,
    access: credentials.access,
    expires: Date.now() + TEN_YEARS_MS,
  }
}

/**
 * Returns the access token (API key) from OAuth credentials.
 */
export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access
}
