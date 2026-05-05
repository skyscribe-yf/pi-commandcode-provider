/**
 * Tests for the Command Code OAuth / browser auth flow.
 *
 * Tests the local callback server (src/auth-server.ts) and the OAuth
 * integration functions (src/oauth.ts).
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { startAuthServer, type AuthCallback } from "../src/auth-server.ts"
import { getApiKey, login, refreshToken } from "../src/oauth.ts"

describe("startAuthServer()", () => {
  it("starts on a random port and accepts a valid callback POST", async () => {
    const { server, port, waitForCallback } = await startAuthServer()

    const callbackData: AuthCallback = {
      apiKey: "user_testKey123",
      state: "test-state-token",
      userId: "user_123",
      userName: "Test User",
      keyName: "test-key",
    }

    // Simulate the Command Code Studio posting the API key back
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://commandcode.ai",
      },
      body: JSON.stringify(callbackData),
    })

    assert.equal(response.status, 200)
    const body = (await response.json()) as { success: boolean }
    assert.equal(body.success, true)

    const result = await waitForCallback
    assert.equal(result.apiKey, "user_testKey123")
    assert.equal(result.state, "test-state-token")
    assert.equal(result.userId, "user_123")
    assert.equal(result.userName, "Test User")
    assert.equal(result.keyName, "test-key")

    // Server closes itself after callback; ensure it's done
    await new Promise((resolve) => {
      if (!server.listening) return resolve(undefined)
      server.on("close", resolve)
    })
  })

  it("rejects when the callback indicates access_denied", async () => {
    const { server, port, waitForCallback } = await startAuthServer()

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://commandcode.ai",
      },
      body: JSON.stringify({
        error: "access_denied",
        error_description: "User cancelled",
      }),
    })

    assert.equal(response.status, 200)

    await assert.rejects(() => waitForCallback, /User cancelled/)

    await new Promise((resolve) => {
      if (!server.listening) return resolve(undefined)
      server.on("close", resolve)
    })
  })

  it("returns 400 for missing required fields", async () => {
    const { server, port } = await startAuthServer()

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://commandcode.ai",
      },
      body: JSON.stringify({ apiKey: "key", state: "s" }),
    })

    assert.equal(response.status, 400)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("handles CORS preflight OPTIONS request", async () => {
    const { server, port } = await startAuthServer()

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "OPTIONS",
      headers: { Origin: "https://commandcode.ai" },
    })

    assert.equal(response.status, 204)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("returns 404 for non-callback paths", async () => {
    const { server, port } = await startAuthServer()

    const response = await fetch(`http://127.0.0.1:${port}/other`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })

    assert.equal(response.status, 404)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("returns 405 for GET on /callback", async () => {
    const { server, port } = await startAuthServer()

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "GET",
      headers: { Origin: "https://commandcode.ai" },
    })

    assert.equal(response.status, 405)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })
})

describe("OAuth functions", () => {
  it("getApiKey returns the access token", () => {
    const creds = {
      refresh: "refresh-key",
      access: "access-key",
      expires: Date.now() + 3600000,
    }
    assert.equal(getApiKey(creds), "access-key")
  })

  it("refreshToken returns updated far-future expiry", async () => {
    const creds = {
      refresh: "my-api-key",
      access: "my-api-key",
      expires: Date.now() - 1000, // already expired
    }
    const result = await refreshToken(creds)
    assert.equal(result.access, "my-api-key")
    assert.equal(result.refresh, "my-api-key")
    assert.ok(result.expires > Date.now(), "expiry should be in the future")
  })
})

describe("login()", () => {
  it("completes the full browser login flow via the local server", async () => {
    let authUrl = ""
    const callbacks = {
      onAuth(params: { url: string }) {
        authUrl = params.url
      },
      onPrompt(params: { message: string }): Promise<string> {
        throw new Error("onPrompt should not be called in browser flow")
      },
    }

    // Start login in the background
    const loginPromise = login(callbacks)

    // Verify the auth URL was passed to callbacks
    assert.match(
      authUrl,
      /^https:\/\/commandcode\.ai\/studio\/auth\/cli\?callback=http:\/\/localhost:\d+\/callback&state=/,
    )

    // Extract port and state from the URL
    const url = new URL(authUrl)
    const port = parseInt(url.searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1] ?? "0")
    const state = url.searchParams.get("state") ?? ""

    assert.ok(port > 0, "auth server should be on a non-zero port")
    assert.ok(state.length > 0, "state token should not be empty")

    // Simulate the Command Code Studio posting the API key back
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://commandcode.ai",
      },
      body: JSON.stringify({
        apiKey: "user_browserApiKey",
        state,
        userId: "user_456",
        userName: "Browser User",
        keyName: "browser-key",
      }),
    })

    assert.equal(response.status, 200)

    const result = await loginPromise
    assert.equal(result.access, "user_browserApiKey")
    assert.equal(result.refresh, "user_browserApiKey")
    assert.ok(result.expires > Date.now(), "expiry should be far in the future")
  })

  it("rejects on state token mismatch", async () => {
    let authUrl = ""
    const callbacks = {
      onAuth(params: { url: string }) {
        authUrl = params.url
      },
      onPrompt(params: { message: string }): Promise<string> {
        throw new Error("should not prompt")
      },
    }

    const loginPromise = login(callbacks)

    const url = new URL(authUrl)
    const port = parseInt(url.searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1] ?? "0")

    // Post back with a wrong state token
    await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://commandcode.ai",
      },
      body: JSON.stringify({
        apiKey: "user_badState",
        state: "wrong-state-token",
        userId: "user_789",
        userName: "Attacker",
        keyName: "evil-key",
      }),
    })

    await assert.rejects(() => loginPromise, /State token mismatch/)
  })
})
